import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';
import { bucketLabel, type DateWindow } from './date-utils';

export interface LedgerSummary {
  revenue: number;
  costs: number;
  net: number;
}

export interface LedgerTrendRow {
  label: string;
  revenue: number;
  costs: number;
}

export interface LedgerCategoryRow {
  label: string;
  value: number;
}

function summarizeByType(
  rows: Array<{ type: string; total: Prisma.Decimal | null }>,
): LedgerSummary {
  let revenue = 0;
  let costs = 0;
  for (const row of rows) {
    const amount = toNumber(row.total ?? 0);
    if (row.type === 'revenue') revenue += amount;
    else costs += amount;
  }
  return { revenue, costs, net: revenue - costs };
}

export async function ledgerSummaryInWindow(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<LedgerSummary> {
  const rows = await db.$queryRaw<
    Array<{ type: string; total: Prisma.Decimal | null }>
  >`
    SELECT type, COALESCE(SUM(amount), 0) AS total
    FROM "LedgerEntry"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND date >= ${from}
      AND date <= ${to}
    GROUP BY type
  `;
  return summarizeByType(rows);
}

export async function ledgerCurrency(
  db: TenantScopedPrisma,
  tenantId: string,
): Promise<string> {
  const row = await db.ledgerEntry.findFirst({
    where: { tenantId, deletedAt: null },
    select: { currency: true },
    orderBy: { id: 'asc' },
  });
  return row?.currency ?? 'NGN';
}

function dateTruncUnit(spanDays: number): 'hour' | 'day' | 'month' {
  if (spanDays <= 2) return 'hour';
  if (spanDays <= 60) return 'day';
  return 'month';
}

export async function ledgerPlTrend(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<LedgerTrendRow[]> {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const unit = dateTruncUnit(spanDays);

  const rows = await db.$queryRaw<
    Array<{
      bucket: Date;
      type: string;
      total: Prisma.Decimal | null;
    }>
  >`
    SELECT date_trunc(${unit}, date) AS bucket, type, COALESCE(SUM(amount), 0) AS total
    FROM "LedgerEntry"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND date >= ${window.from}
      AND date <= ${window.to}
    GROUP BY bucket, type
    ORDER BY bucket ASC
  `;

  const buckets = new Map<string, LedgerTrendRow>();
  for (const row of rows) {
    const label = bucketLabel(row.bucket, spanDays);
    const existing = buckets.get(label) ?? { label, revenue: 0, costs: 0 };
    const amount = toNumber(row.total ?? 0);
    if (row.type === 'revenue') existing.revenue += amount;
    else existing.costs += amount;
    buckets.set(label, existing);
  }

  const data = Array.from(buckets.values()).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
  return data.length > 0 ? data : [{ label: '—', revenue: 0, costs: 0 }];
}

export async function ledgerExpenseBreakdown(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<LedgerCategoryRow[]> {
  const rows = await db.$queryRaw<
    Array<{ category: string; total: Prisma.Decimal | null }>
  >`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM "LedgerEntry"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND type <> 'revenue'
      AND date >= ${from}
      AND date <= ${to}
    GROUP BY category
    ORDER BY total DESC
    LIMIT 8
  `;

  const data = rows.map((row) => ({
    label: row.category,
    value: toNumber(row.total ?? 0),
  }));
  return data.length > 0 ? data : [{ label: '—', value: 0 }];
}

export async function ledgerRevenueBreakdown(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<LedgerCategoryRow[]> {
  const rows = await db.$queryRaw<
    Array<{ category: string; total: Prisma.Decimal | null }>
  >`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM "LedgerEntry"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND type = 'revenue'
      AND date >= ${from}
      AND date <= ${to}
    GROUP BY category
    ORDER BY total DESC
    LIMIT 12
  `;

  const data = rows.map((row) => ({
    label: row.category,
    value: toNumber(row.total ?? 0),
  }));
  return data.length > 0 ? data : [{ label: '—', value: 0 }];
}

export interface LedgerChartsPayload {
  plTrend: LedgerTrendRow[];
  revenueByCategory: LedgerCategoryRow[];
}
