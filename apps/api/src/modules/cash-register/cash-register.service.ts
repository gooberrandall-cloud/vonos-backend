import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { toIso } from '../../common/utils/serializers';

export type CashRegisterSummary = {
  salesCount: number;
  totalSales: number;
  cash: number;
  card: number;
  other: number;
};

export type CashRegisterView = {
  id: string;
  tenantId: string;
  locationCode: string | null;
  status: string;
  openingBalance: number;
  openedAt: string;
  closedAt: string | null;
  closingAmount: number | null;
  totalCardSlips: number | null;
  totalCheques: number | null;
  closingNote: string | null;
  summary: CashRegisterSummary;
};

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

@Injectable()
export class CashRegisterService {
  constructor(private readonly tenantDb: TenantDbService) {}

  private serialize(
    row: {
      id: string;
      tenantId: string;
      locationCode: string | null;
      status: string;
      openingBalance: unknown;
      openedAt: Date;
      closedAt: Date | null;
      closingAmount: unknown;
      totalCardSlips: unknown;
      totalCheques: unknown;
      closingNote: string | null;
    },
    summary: CashRegisterSummary,
  ): CashRegisterView {
    return {
      id: row.id,
      tenantId: row.tenantId,
      locationCode: row.locationCode,
      status: row.status,
      openingBalance: num(row.openingBalance),
      openedAt: toIso(row.openedAt),
      closedAt: row.closedAt ? toIso(row.closedAt) : null,
      closingAmount: row.closingAmount == null ? null : num(row.closingAmount),
      totalCardSlips:
        row.totalCardSlips == null ? null : num(row.totalCardSlips),
      totalCheques: row.totalCheques == null ? null : num(row.totalCheques),
      closingNote: row.closingNote,
      summary,
    };
  }

  /** Sales totals within the register window, split by payment method. */
  private async summarize(
    tenantId: string,
    openedAt: Date,
    closedAt: Date | null,
  ): Promise<CashRegisterSummary> {
    const windowEnd = closedAt ?? new Date();
    const sales = await this.tenantDb.db.sale.findMany({
      where: {
        tenantId,
        deletedAt: null,
        createdAt: { gte: openedAt, lte: windowEnd },
        status: { notIn: ['draft', 'quotation'] },
      },
      select: { total: true, payments: { select: { amount: true, method: true } } },
    });
    let cash = 0;
    let card = 0;
    let other = 0;
    for (const sale of sales) {
      for (const payment of sale.payments ?? []) {
        const amount = num(payment.amount);
        const method = (payment.method ?? '').toLowerCase();
        if (method === 'cash') cash += amount;
        else if (method === 'card') card += amount;
        else other += amount;
      }
    }
    return {
      salesCount: sales.length,
      totalSales: sales.reduce((sum, sale) => sum + num(sale.total), 0),
      cash,
      card,
      other,
    };
  }

  async current(): Promise<CashRegisterView | null> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.cashRegister.findFirst({
      where: { tenantId, status: 'open', deletedAt: null },
      orderBy: { openedAt: 'desc' },
    });
    if (!row) return null;
    return this.serialize(row, await this.summarize(tenantId, row.openedAt, null));
  }

  async open(body: {
    openingBalance?: number;
    locationCode?: string;
  }): Promise<CashRegisterView> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.cashRegister.findFirst({
      where: { tenantId, status: 'open', deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('A register is already open');
    }
    const row = await this.tenantDb.db.cashRegister.create({
      data: {
        tenantId,
        locationCode: body.locationCode?.trim() || null,
        openingBalance: num(body.openingBalance),
      },
    });
    return this.serialize(row, await this.summarize(tenantId, row.openedAt, null));
  }

  async close(body: {
    closingAmount?: number;
    totalCardSlips?: number;
    totalCheques?: number;
    closingNote?: string;
  }): Promise<CashRegisterView> {
    const tenantId = this.tenantDb.requireTenantId();
    const open = await this.tenantDb.db.cashRegister.findFirst({
      where: { tenantId, status: 'open', deletedAt: null },
      orderBy: { openedAt: 'desc' },
    });
    if (!open) throw new BadRequestException('No open register to close');
    const closedAt = new Date();
    const row = await this.tenantDb.db.cashRegister.update({
      where: { id: open.id },
      data: {
        status: 'closed',
        closedAt,
        closingAmount: num(body.closingAmount),
        totalCardSlips: num(body.totalCardSlips),
        totalCheques: num(body.totalCheques),
        closingNote: body.closingNote?.trim() || null,
      },
    });
    return this.serialize(row, await this.summarize(tenantId, row.openedAt, closedAt));
  }

  async history(limit = 20): Promise<CashRegisterView[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.cashRegister.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { openedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    const out: CashRegisterView[] = [];
    for (const row of rows) {
      out.push(
        this.serialize(
          row,
          await this.summarize(tenantId, row.openedAt, row.closedAt ?? null),
        ),
      );
    }
    return out;
  }
}
