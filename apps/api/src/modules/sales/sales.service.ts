import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  PaymentStatus,
  Sale,
  SaleDetail,
  SaleFilters,
  SaleLine,
} from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { buildCursorQuery } from '../../common/utils/pagination';
import { computeStockStatus } from '../../common/utils/stockQuantity';
import {
  mapSaleStatusToUi,
  toIso,
  toNumber,
} from '../../common/utils/serializers';

@Injectable()
export class SalesService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(filters: SaleFilters): Promise<Sale[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.sale.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? {
              OR: [
                {
                  reference: { contains: filters.search, mode: 'insensitive' },
                },
                {
                  customer: {
                    name: { contains: filters.search, mode: 'insensitive' },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        customer: true,
        lines: true,
      },
      orderBy: { date: 'desc' },
      ...buildCursorQuery(filters.cursor, filters.limit ?? 50),
    });

    return rows.map((row) => this.toSale(row));
  }

  async getById(id: string): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { customer: true, lines: true },
    });
    if (!row) throw new NotFoundException('Sale not found');
    return this.toSaleDetail(row);
  }

  async create(body: {
    reference: string;
    customerName?: string;
    locationCode?: string;
    lines: Array<{
      itemId?: string;
      sku: string;
      name: string;
      quantity: number;
      unitPrice: number;
    }>;
    currency?: string;
    date?: string;
    payments?: Array<{
      amount: number;
      method?: string;
      note?: string;
      accountId?: string;
    }>;
  }): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const createdBy = await this.auditService.createdByFields();
    const locationCode = await this.tenantDb.resolveBusinessLocation(
      body.locationCode,
    );
    const currency = body.currency ?? 'NGN';
    const saleDate = body.date ? new Date(body.date) : new Date();

    let customerId: string | null = null;
    if (body.customerName?.trim()) {
      const existing = await this.tenantDb.db.customer.findFirst({
        where: {
          tenantId,
          deletedAt: null,
          name: { equals: body.customerName.trim(), mode: 'insensitive' },
        },
      });
      if (existing) {
        customerId = existing.id;
      } else {
        const customer = await this.tenantDb.db.customer.create({
          data: {
            tenantId,
            name: body.customerName.trim(),
            ...createdBy,
          },
        });
        customerId = customer.id;
      }
    }

    const lineData = body.lines.map((line) => {
      const lineTotal = line.quantity * line.unitPrice;
      return {
        itemId: line.itemId ?? null,
        sku: line.sku,
        name: line.name,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal,
        discountAmount: null,
      };
    });
    const total = lineData.reduce((sum, line) => sum + line.lineTotal, 0);

    const paymentRows =
      body.payments && body.payments.length > 0
        ? body.payments
        : [{ amount: total, method: 'cash' }];

    const paidTotal = paymentRows.reduce((sum, row) => sum + row.amount, 0);
    let paymentStatus: PaymentStatus = 'paid';
    if (paidTotal <= 0) {
      paymentStatus = 'due';
    } else if (paidTotal < total) {
      paymentStatus = 'partial';
    }

    const row = await this.prisma.$transaction(async (tx) => {
      for (const line of body.lines) {
        if (!line.itemId) continue;
        const item = await tx.item.findFirst({
          where: { id: line.itemId, deletedAt: null },
        });
        if (!item) {
          throw new BadRequestException(`Item not found: ${line.sku}`);
        }
        const currentQty = toNumber(item.quantity);
        const nextQuantity = currentQty - line.quantity;
        if (nextQuantity < 0) {
          throw new BadRequestException(
            `Insufficient stock for ${line.sku} (need ${line.quantity}, have ${currentQty})`,
          );
        }
        await tx.item.update({
          where: { id: item.id },
          data: {
            quantity: nextQuantity,
            status: computeStockStatus(nextQuantity, item.reorderPoint),
          },
        });
      }

      const sale = await tx.sale.create({
        data: {
          tenantId,
          reference: body.reference,
          customerId,
          total,
          currency,
          status: 'completed',
          paymentStatus,
          locationCode,
          date: saleDate,
          lines: { create: lineData },
          ...createdBy,
        },
        include: { customer: true, lines: true },
      });

      await tx.ledgerEntry.create({
        data: {
          tenantId,
          type: 'revenue',
          amount: total,
          currency,
          category: 'Sales',
          description: `Sale ${sale.reference}`,
          linkedRecordType: 'sale',
          linkedRecordId: sale.id,
          date: saleDate,
        },
      });

      for (const payment of paymentRows) {
        if (payment.amount <= 0) continue;
        await tx.payment.create({
          data: {
            tenantId,
            amount: payment.amount,
            currency,
            method: payment.method ?? 'cash',
            paidOn: saleDate,
            paymentFor: 'sale',
            saleId: sale.id,
            accountId: payment.accountId ?? null,
            note: payment.note ?? null,
            createdByName: createdBy.createdByName ?? null,
          },
        });
      }

      return sale;
    });

    await this.auditService.log({
      action: 'created',
      entityType: 'sale',
      entityId: row.id,
      summary: `Recorded sale ${row.reference}`,
      metadata: { total, paymentStatus },
    });

    return this.toSaleDetail(row);
  }

  private toSale(row: {
    id: string;
    tenantId: string;
    reference: string;
    customerId: string | null;
    customer: { name: string } | null;
    total: { toString(): string };
    currency: string;
    status: string;
    paymentStatus: string | null;
    locationCode: string | null;
    date: Date;
    createdByUserId: string | null;
    createdByName: string | null;
    createdAt: Date;
    updatedAt: Date;
    lines: Array<unknown>;
  }): Sale {
    return {
      id: row.id,
      tenantId: row.tenantId,
      reference: row.reference,
      customerId: row.customerId,
      customerName: row.customer?.name ?? 'Walk-in',
      total: toNumber(row.total),
      currency: row.currency,
      status: mapSaleStatusToUi(row.status),
      paymentStatus: row.paymentStatus as PaymentStatus | null,
      locationCode: row.locationCode,
      itemCount: row.lines.length,
      date: toIso(row.date).slice(0, 10),
      createdByUserId: row.createdByUserId,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  private toSaleDetail(row: {
    id: string;
    tenantId: string;
    reference: string;
    customerId: string | null;
    customer: { name: string } | null;
    total: { toString(): string };
    currency: string;
    status: string;
    paymentStatus: string | null;
    locationCode: string | null;
    date: Date;
    createdByUserId: string | null;
    createdByName: string | null;
    createdAt: Date;
    updatedAt: Date;
    lines: Array<{
      id: string;
      saleId: string;
      itemId: string | null;
      sku: string;
      name: string;
      quantity: { toString(): string };
      unitPrice: { toString(): string };
      lineTotal: { toString(): string };
      discountAmount: { toString(): string } | null;
    }>;
  }): SaleDetail {
    const base = this.toSale(row);
    const lines: SaleLine[] = row.lines.map((line) => ({
      id: line.id,
      saleId: line.saleId,
      itemId: line.itemId,
      sku: line.sku,
      name: line.name,
      quantity: toNumber(line.quantity),
      unitPrice: toNumber(line.unitPrice),
      lineTotal: toNumber(line.lineTotal),
      discountAmount: line.discountAmount
        ? toNumber(line.discountAmount)
        : null,
    }));
    return { ...base, lines };
  }
}
