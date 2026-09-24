import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentStatus,
  Prisma,
  SaleStatus,
  StoreFulfillmentType,
  StoreOrderStatus,
} from '@prisma/client';
import { isOutsideOrServiceCatalogItem } from '@vonos/types';
import { CacheService } from '../../common/cache/cache.service';
import {
  invalidateTenantDashboardCache,
  invalidateTenantListCache,
} from '../../common/cache/cacheInvalidation';
import { PrismaService } from '../../common/prisma/prisma.service';
import { allocateNextInvoiceNumber } from '../../common/utils/allocateInvoiceNumber';
import { applyDailyFinanceDelta } from '../../common/utils/dailyFinanceRollup';
import { refreshCustomerFinancialRollups } from '../../common/utils/customerRollups';
import {
  adjustItemLocationStock,
  effectiveItemOnHand,
} from '../../common/utils/itemLocationStock';
import { recordPaymentAccountTxn } from '../../common/utils/recordPaymentAccountTxn';
import { computeStockStatus } from '../../common/utils/stockQuantity';
import { InvoiceHubService } from '../invoices/invoice-hub.service';
import { PaystackService } from './paystack.service';
import { StoreCatalogService } from './store-catalog.service';

type CheckoutLineInput = { itemId: string; qty: number };

type CheckoutInput = {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  registration?: string;
  fulfillment: StoreFulfillmentType;
  notes?: string;
  lines: CheckoutLineInput[];
  callbackUrl: string;
};

type PendingFinanceDelta = {
  tenantId: string;
  amount: number;
  currency: string;
  date: Date;
};

/**
 * When false, paid store orders still create Sale + ledger/revenue for the
 * dashboard, but skip on-hand deduction (local testing). Default true so
 * Paystack-paid parts sales tally stock exactly.
 */
function shouldDeductStoreStock(): boolean {
  const raw = process.env.STORE_DEDUCT_STOCK?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return true;
}

function shippingAddressFromNotes(notes: string | null | undefined): string | null {
  if (!notes?.trim()) return null;
  const match = notes.match(/Delivery address:\s*(.+?)(?:\n|$)/i);
  return match?.[1]?.trim() || notes.trim().slice(0, 500) || null;
}

@Injectable()
export class StoreCheckoutService {
  private readonly logger = new Logger(StoreCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: StoreCatalogService,
    private readonly paystack: PaystackService,
    private readonly cache: CacheService,
    private readonly invoiceHub: InvoiceHubService,
  ) {}

  private generateReference(): string {
    const suffix = Math.floor(10000 + Math.random() * 90000);
    return `VON-${suffix}`;
  }

  async createCheckout(input: CheckoutInput) {
    if (!input.lines.length) {
      throw new BadRequestException('Cart is empty');
    }

    let resolved;
    try {
      resolved = await this.catalog.resolveCartLines(input.lines);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid cart',
      );
    }

    const subtotal = resolved.reduce((sum, line) => sum + line.lineTotal, 0);
    const total = subtotal;
    const reference = this.generateReference();
    const paystackReference = `store_${reference}`;

    const order = await this.prisma.storeOrder.create({
      data: {
        reference,
        fulfillment: input.fulfillment,
        customerName: input.customerName.trim(),
        customerEmail: input.customerEmail.trim(),
        customerPhone: input.customerPhone.trim(),
        registration: input.registration?.trim().toUpperCase() || null,
        notes: input.notes?.trim() || null,
        subtotal,
        total,
        paystackReference,
        lines: {
          // VISP slices first (resolveCartLines already sorts VISP → VSP).
          create: resolved.map((line) => ({
            tenantId: line.tenantId,
            itemId: line.itemId,
            sku: line.sku,
            name: line.name,
            qty: line.qty,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
          })),
        },
      },
      include: { lines: true },
    });

    const amountKobo = Math.round(total * 100);
    // Absolute confirmation URL with our order ref. Paystack appends
    // reference/trxref on return; OrderConfirmationPanel accepts both.
    const baseCallback = input.callbackUrl.trim();
    const separator = baseCallback.includes('?') ? '&' : '?';
    const callbackUrl = `${baseCallback}${separator}ref=${encodeURIComponent(reference)}`;
    const paystack = await this.paystack.initializeTransaction({
      email: order.customerEmail,
      amountKobo,
      reference: paystackReference,
      callbackUrl,
      metadata: {
        storeOrderId: order.id,
        storeReference: order.reference,
      },
    });

    await this.prisma.storeOrder.update({
      where: { id: order.id },
      data: { paystackAccessCode: paystack.accessCode },
    });

    return {
      orderReference: order.reference,
      total,
      currency: order.currency,
      paystackPublicKey: this.paystack.publicKey,
      authorizationUrl: paystack.authorizationUrl,
      accessCode: paystack.accessCode,
      paystackReference: paystack.reference,
    };
  }

  async getOrder(reference: string) {
    const order = await this.prisma.storeOrder.findUnique({
      where: { reference: this.normalizeStoreReference(reference) },
      include: {
        lines: true,
        sales: {
          include: {
            sale: { select: { id: true, reference: true, tenantId: true } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Accept VON-… or Paystack’s store_VON-… from callbacks. */
  private normalizeStoreReference(reference: string): string {
    const trimmed = reference.trim();
    return trimmed.startsWith('store_') ? trimmed.slice('store_'.length) : trimmed;
  }

  async handlePaystackWebhook(payload: {
    event: string;
    data?: { reference?: string; status?: string; amount?: number };
  }) {
    if (payload.event !== 'charge.success' || !payload.data?.reference) {
      return { ok: true, ignored: true };
    }

    const paystackReference = payload.data.reference;
    const order = await this.prisma.storeOrder.findUnique({
      where: { paystackReference },
      include: { lines: true, sales: true },
    });
    if (!order) {
      this.logger.warn(
        `Paystack webhook for unknown reference ${paystackReference}`,
      );
      return { ok: true, missing: true };
    }

    if (order.status === StoreOrderStatus.paid) {
      return { ok: true, alreadyPaid: true };
    }

    const verified = await this.paystack.verifyTransaction(paystackReference);
    if (!verified || verified.status !== 'success') {
      throw new BadRequestException('Paystack payment not successful');
    }

    await this.markPaidAndCreateSales(order.id);
    return { ok: true, paid: true };
  }

  /** Confirm payment after browser return (idempotent). */
  async confirmPaid(reference: string) {
    const normalized = this.normalizeStoreReference(reference);
    const order = await this.prisma.storeOrder.findUnique({
      where: { reference: normalized },
      include: { lines: true, sales: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === StoreOrderStatus.paid) return order;

    if (!order.paystackReference) {
      throw new BadRequestException('Order has no Paystack reference');
    }

    const verified = await this.paystack.verifyTransaction(
      order.paystackReference,
    );
    if (!verified || verified.status !== 'success') {
      throw new BadRequestException('Payment not completed yet');
    }

    await this.markPaidAndCreateSales(order.id);
    return this.getOrder(normalized);
  }

  private async markPaidAndCreateSales(orderId: string) {
    const deductStock = shouldDeductStoreStock();
    const touchedTenants = new Set<string>();
    const customerIdsToRefresh = new Set<string>();
    const pendingFinance: PendingFinanceDelta[] = [];

    await this.prisma.$transaction(
      async (tx) => {
        const order = await tx.storeOrder.findUnique({
          where: { id: orderId },
          include: { lines: true, sales: true },
        });
        if (!order || order.status === StoreOrderStatus.paid) return;

        // Re-verify stock at pay time (race with other sales).
        if (deductStock) {
          for (const line of order.lines) {
            if (
              isOutsideOrServiceCatalogItem({
                name: line.name,
                sku: line.sku,
              })
            ) {
              continue;
            }
            const item = await tx.item.findFirst({
              where: {
                id: line.itemId,
                tenantId: line.tenantId,
                deletedAt: null,
              },
            });
            if (!item) {
              throw new BadRequestException(`Item not found: ${line.sku}`);
            }
            const onHand = await effectiveItemOnHand(
              tx,
              item.id,
              Number(item.quantity),
            );
            if (onHand < line.qty) {
              throw new BadRequestException(
                `Insufficient stock for ${line.sku} (need ${line.qty}, have ${onHand})`,
              );
            }
          }
        }

        await tx.storeOrder.update({
          where: { id: order.id },
          data: {
            status: StoreOrderStatus.paid,
            paidAt: new Date(),
          },
        });

        const byTenant = new Map<string, typeof order.lines>();
        for (const line of order.lines) {
          const list = byTenant.get(line.tenantId) ?? [];
          list.push(line);
          byTenant.set(line.tenantId, list);
        }

        // Process VISP before VSP when both appear (stable Map iteration is
        // insertion order from order.lines, which is VISP-first).
        const shippingAddress = shippingAddressFromNotes(order.notes);
        const saleDate = new Date();

        for (const [tenantId, lines] of byTenant) {
          if (order.sales.some((link) => link.tenantId === tenantId)) continue;
          touchedTenants.add(tenantId);

          const customer = await this.findOrCreateStoreCustomer(tx, {
            tenantId,
            name: order.customerName,
            email: order.customerEmail,
            phone: order.customerPhone,
            registration: order.registration,
            fulfillment: order.fulfillment,
            storeOrderReference: order.reference,
          });
          customerIdsToRefresh.add(customer.id);

          const saleReference = await allocateNextInvoiceNumber(tx, tenantId);
          const total = lines.reduce(
            (sum, line) => sum + Number(line.lineTotal),
            0,
          );

          if (deductStock) {
            await this.deductStoreLines(tx, tenantId, lines);
          }

          const paystackAccount = await tx.paymentAccount.findFirst({
            where: {
              tenantId,
              deletedAt: null,
              isClosed: false,
              OR: [
                { name: { contains: 'paystack', mode: 'insensitive' } },
                { name: { contains: 'online', mode: 'insensitive' } },
              ],
            },
            select: { id: true },
          });

          const sale = await tx.sale.create({
            data: {
              tenantId,
              reference: saleReference,
              customerId: customer.id,
              total,
              currency: order.currency,
              status: SaleStatus.completed,
              paymentStatus: PaymentStatus.paid,
              totalPaid: total,
              itemCount: lines.length,
              paymentMethod: 'paystack',
              shippingAddress,
              shippingStatus:
                order.fulfillment === StoreFulfillmentType.delivery
                  ? 'pending'
                  : null,
              notes: [
                `Online store order ${order.reference}`,
                order.notes,
                order.registration ? `Reg: ${order.registration}` : null,
                `Fulfillment: ${order.fulfillment}`,
              ]
                .filter(Boolean)
                .join(' · '),
              date: saleDate,
              lines: {
                create: lines.map((line) => ({
                  itemId: line.itemId,
                  sku: line.sku,
                  name: line.name,
                  quantity: line.qty,
                  unitPrice: line.unitPrice,
                  lineTotal: line.lineTotal,
                })),
              },
              payments: {
                create: {
                  tenantId,
                  amount: total,
                  currency: order.currency,
                  method: 'paystack',
                  paymentRefNo: order.paystackReference,
                  paidOn: saleDate,
                  paymentFor: 'sale',
                  note: `Store checkout ${order.reference}`,
                  accountId: paystackAccount?.id ?? null,
                },
              },
            },
            include: {
              lines: true,
              payments: true,
              customer: { select: { name: true } },
            },
          });

          const invoice = await this.invoiceHub.ensureSaleInvoice(tx, sale, sale.lines);

          await tx.ledgerEntry.create({
            data: {
              tenantId,
              type: 'revenue',
              amount: total,
              currency: order.currency,
              category: 'Sales',
              description: `Online store ${order.reference} (${saleReference})`,
              linkedRecordType: 'sale',
              linkedRecordId: sale.id,
              invoiceId: invoice?.id ?? null,
              date: saleDate,
            },
          });

          const payment = sale.payments[0];
          if (payment?.accountId) {
            await recordPaymentAccountTxn(tx, {
              tenantId,
              accountId: payment.accountId,
              type: 'credit',
              subType: 'sale_payment',
              amount: total,
              operationDate: saleDate,
              refNo: order.paystackReference,
              note: `Store checkout ${order.reference}`,
              paymentMethod: 'paystack',
              saleId: sale.id,
              paymentId: payment.id,
            });
          }

          const movementLines = lines
            .filter(
              (line) =>
                !isOutsideOrServiceCatalogItem({
                  name: line.name,
                  sku: line.sku,
                }),
            )
            .map((line) => ({
              itemId: line.itemId,
              sku: line.sku,
              name: line.name,
              quantity: line.qty,
              unitCost: 0,
            }));

          if (movementLines.length > 0) {
            await tx.stockMovement.create({
              data: {
                tenantId,
                type: 'outbound',
                reference: `SO-${saleReference}`,
                status: 'Delivered',
                lines: movementLines as unknown as Prisma.InputJsonValue,
                itemCount: movementLines.length,
                grandTotal: 0,
                notes: `saleId:${sale.id}|store ${order.reference}`,
                date: saleDate,
              },
            });
          }

          await tx.storeOrderSale.create({
            data: {
              orderId: order.id,
              tenantId,
              saleId: sale.id,
            },
          });

          pendingFinance.push({
            tenantId,
            amount: total,
            currency: order.currency,
            date: saleDate,
          });
        }
      },
      { maxWait: 15_000, timeout: 60_000 },
    );

    for (const delta of pendingFinance) {
      void applyDailyFinanceDelta(
        this.prisma,
        delta.tenantId,
        delta.date,
        'revenue',
        delta.amount,
        delta.currency,
      );
    }

    for (const tenantId of touchedTenants) {
      void invalidateTenantDashboardCache(this.cache, tenantId);
      void invalidateTenantListCache(this.cache, tenantId, [
        'sales:v2',
        'sales',
        'items',
        'catalog',
      ]);
    }

    for (const customerId of customerIdsToRefresh) {
      void refreshCustomerFinancialRollups(this.prisma, customerId);
    }
  }

  private async findOrCreateStoreCustomer(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      name: string;
      email: string;
      phone: string;
      registration: string | null;
      fulfillment: StoreFulfillmentType;
      storeOrderReference: string;
    },
  ) {
    const email = args.email.trim().toLowerCase();
    const existing = email
      ? await tx.customer.findFirst({
          where: {
            tenantId: args.tenantId,
            deletedAt: null,
            email: { equals: email, mode: 'insensitive' },
          },
        })
      : null;

    if (existing) {
      return tx.customer.update({
        where: { id: existing.id },
        data: {
          name: args.name.trim() || existing.name,
          phone: args.phone.trim() || existing.phone,
          details: {
            ...(typeof existing.details === 'object' && existing.details
              ? (existing.details as Record<string, unknown>)
              : {}),
            source: 'public_store',
            registration: args.registration,
            fulfillment: args.fulfillment,
            storeOrderReference: args.storeOrderReference,
          },
        },
      });
    }

    return tx.customer.create({
      data: {
        tenantId: args.tenantId,
        name: args.name.trim(),
        email: args.email.trim(),
        phone: args.phone.trim(),
        details: {
          source: 'public_store',
          registration: args.registration,
          fulfillment: args.fulfillment,
          storeOrderReference: args.storeOrderReference,
        },
      },
    });
  }

  private async deductStoreLines(
    tx: Prisma.TransactionClient,
    tenantId: string,
    lines: Array<{
      itemId: string;
      sku: string;
      name: string;
      qty: number;
    }>,
  ): Promise<void> {
    for (const line of lines) {
      if (
        isOutsideOrServiceCatalogItem({
          name: line.name,
          sku: line.sku,
        })
      ) {
        continue;
      }
      const item = await tx.item.findFirst({
        where: { id: line.itemId, tenantId, deletedAt: null },
      });
      if (!item) {
        throw new BadRequestException(`Item not found: ${line.sku}`);
      }
      const headerQty = Number(item.quantity);
      const onHand = await effectiveItemOnHand(tx, item.id, headerQty);
      const nextQuantity = onHand - line.qty;
      if (nextQuantity < 0) {
        throw new BadRequestException(
          `Insufficient stock for ${line.sku} (need ${line.qty}, have ${onHand})`,
        );
      }
      await tx.item.update({
        where: { id: item.id },
        data: {
          quantity: nextQuantity,
          status: computeStockStatus(
            nextQuantity,
            item.reorderPoint != null ? Number(item.reorderPoint) : null,
          ),
        },
      });
      await adjustItemLocationStock(tx, {
        tenantId,
        itemId: item.id,
        locationCode: item.locationCode,
        binLocation: item.binLocation,
        delta: -line.qty,
      });
    }
  }
}
