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
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { PrismaService } from '../../common/prisma/prisma.service';
import { allocateNextInvoiceNumber } from '../../common/utils/allocateInvoiceNumber';
import { applyDailyFinanceDelta } from '../../common/utils/dailyFinanceRollup';
import {
  adjustItemLocationStock,
  effectiveItemOnHand,
} from '../../common/utils/itemLocationStock';
import { computeStockStatus } from '../../common/utils/stockQuantity';
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

@Injectable()
export class StoreCheckoutService {
  private readonly logger = new Logger(StoreCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: StoreCatalogService,
    private readonly paystack: PaystackService,
    private readonly cache: CacheService,
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
    const separator = input.callbackUrl.includes('?') ? '&' : '?';
    const paystack = await this.paystack.initializeTransaction({
      email: order.customerEmail,
      amountKobo,
      reference: paystackReference,
      callbackUrl: `${input.callbackUrl}${separator}ref=${encodeURIComponent(reference)}`,
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
      where: { reference },
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
    const order = await this.prisma.storeOrder.findUnique({
      where: { reference },
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
    return this.getOrder(reference);
  }

  private async markPaidAndCreateSales(orderId: string) {
    const deductStock = shouldDeductStoreStock();
    const touchedTenants = new Set<string>();

    await this.prisma.$transaction(
      async (tx) => {
        const order = await tx.storeOrder.findUnique({
          where: { id: orderId },
          include: { lines: true, sales: true },
        });
        if (!order || order.status === StoreOrderStatus.paid) return;

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

        for (const [tenantId, lines] of byTenant) {
          if (order.sales.some((link) => link.tenantId === tenantId)) continue;
          touchedTenants.add(tenantId);

          const customer = await tx.customer.create({
            data: {
              tenantId,
              name: order.customerName,
              email: order.customerEmail,
              phone: order.customerPhone,
              details: {
                source: 'public_store',
                registration: order.registration,
                fulfillment: order.fulfillment,
                storeOrderReference: order.reference,
              },
            },
          });

          const saleReference = await allocateNextInvoiceNumber(tx, tenantId);
          const total = lines.reduce(
            (sum, line) => sum + Number(line.lineTotal),
            0,
          );

          if (deductStock) {
            await this.deductStoreLines(tx, tenantId, lines);
          }

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
              notes: [
                `Online store order ${order.reference}`,
                order.notes,
                order.registration ? `Reg: ${order.registration}` : null,
                `Fulfillment: ${order.fulfillment}`,
              ]
                .filter(Boolean)
                .join(' · '),
              date: new Date(),
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
                  paidOn: new Date(),
                  paymentFor: 'sale',
                  note: `Store checkout ${order.reference}`,
                },
              },
            },
          });

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
              date: new Date(),
            },
          });

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
                date: new Date(),
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

          void applyDailyFinanceDelta(
            this.prisma,
            tenantId,
            new Date(),
            'revenue',
            total,
            order.currency,
          );
        }
      },
      { maxWait: 15_000, timeout: 60_000 },
    );

    for (const tenantId of touchedTenants) {
      void invalidateTenantDashboardCache(this.cache, tenantId);
    }
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
