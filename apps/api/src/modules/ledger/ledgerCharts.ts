import { Prisma, type PrismaClient } from '@prisma/client';
import type { TenantScopedPrisma } from '../../common/prisma/prisma.service';
import { EXCLUDE_INTERNAL_TRANSFER_SQL } from '../../common/utils/internalTransfer';
import { runPool } from '../../common/utils/mapPool';
import { toNumber } from '../../common/utils/serializers';
import {
  groupDailyFinanceTrend,
  resolveGroupFinanceSource,
  sumDailyFinanceRollupForTenants,
} from '../../common/utils/dailyFinanceRollup';
import { resolveDateWindow } from '../reports/aggregators/date-utils';
import {
  ledgerPlTrend,
  ledgerRevenueBreakdown,
  type LedgerChartsPayload,
} from '../reports/aggregators/ledgerReportQueries';

const NEON_QUERY_CONCURRENCY = 2;

function dateTruncUnit(spanDays: number): 'hour' | 'day' | 'month' {
  if (spanDays <= 2) return 'hour';
  if (spanDays <= 60) return 'day';
  return 'month';
}

function bucketLabel(date: Date, spanDays: number): string {
  if (spanDays <= 2) {
    return date.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  if (spanDays <= 60) {
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  return date.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

export async function buildTenantLedgerCharts(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<LedgerChartsPayload> {
  const window = resolveDateWindow(from, to);
  const [plTrend, revenueByCategory] = await runPool(
    [
      () => ledgerPlTrend(db, tenantId, window),
      () => ledgerRevenueBreakdown(db, tenantId, window.from, window.to),
    ],
    NEON_QUERY_CONCURRENCY,
  );
  return { plTrend, revenueByCategory };
}

export async function buildGroupLedgerCharts(
  prisma: PrismaClient,
  tenantIds: string[],
  from?: string,
  to?: string,
): Promise<LedgerChartsPayload> {
  if (tenantIds.length === 0) {
    return {
      plTrend: [{ label: '—', revenue: 0, costs: 0 }],
      revenueByCategory: [{ label: '—', value: 0 }],
    };
  }

  const window = resolveDateWindow(from, to);
  const useRollup = await resolveGroupFinanceSource(
    prisma,
    tenantIds,
    window.from,
    window.to,
  );

  if (useRollup) {
    const [plTrend, totals] = await runPool(
      [
        () => groupDailyFinanceTrend(prisma, tenantIds, window.from, window.to),
        () =>
          sumDailyFinanceRollupForTenants(
            prisma,
            tenantIds,
            window.from,
            window.to,
          ),
      ],
      NEON_QUERY_CONCURRENCY,
    );
    const revenueByCategory = [
      { label: 'Costs', value: totals.costs },
      { label: 'Expenses', value: totals.expenses },
    ].filter((row) => row.value > 0);
    return {
      plTrend,
      revenueByCategory:
        revenueByCategory.length > 0
          ? revenueByCategory
          : [{ label: '—', value: 0 }],
    };
  }

  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const unit = dateTruncUnit(spanDays);

  const trendRows = await prisma.$queryRaw<
    Array<{
      bucket: Date;
      type: string;
      total: Prisma.Decimal | null;
    }>
  >`
    SELECT date_trunc(${unit}, date) AS bucket, type, COALESCE(SUM(amount), 0) AS total
    FROM "LedgerEntry"
    WHERE "tenantId" IN (${Prisma.join(tenantIds)})
      AND "deletedAt" IS NULL
      AND date >= ${window.from}
      AND date <= ${window.to}
      ${EXCLUDE_INTERNAL_TRANSFER_SQL}
    GROUP BY bucket, type
    ORDER BY bucket ASC
  `;

  const buckets = new Map<string, { label: string; revenue: number; costs: number }>();
  for (const row of trendRows) {
    const label = bucketLabel(row.bucket, spanDays);
    const existing = buckets.get(label) ?? { label, revenue: 0, costs: 0 };
    const amount = toNumber(row.total ?? 0);
    if (row.type === 'revenue') existing.revenue += amount;
    else existing.costs += amount;
    buckets.set(label, existing);
  }

  const plTrend = Array.from(buckets.values()).sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  const categoryRows = await prisma.$queryRaw<
    Array<{ category: string; total: Prisma.Decimal | null }>
  >`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM "LedgerEntry"
    WHERE "tenantId" IN (${Prisma.join(tenantIds)})
      AND "deletedAt" IS NULL
      AND type = 'revenue'
      AND date >= ${window.from}
      AND date <= ${window.to}
      ${EXCLUDE_INTERNAL_TRANSFER_SQL}
    GROUP BY category
    ORDER BY total DESC
    LIMIT 12
  `;

  const revenueByCategory = categoryRows.map((row) => ({
    label: row.category,
    value: toNumber(row.total ?? 0),
  }));

  return {
    plTrend: plTrend.length > 0 ? plTrend : [{ label: '—', revenue: 0, costs: 0 }],
    revenueByCategory:
      revenueByCategory.length > 0
        ? revenueByCategory
        : [{ label: '—', value: 0 }],
  };
}
