import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  groupRevenueByTenantFromRollup,
  groupRevenueTrendByMonthFromRollup,
  hasDailyFinanceRollupForTenants,
} from '../../../common/utils/dailyFinanceRollup';
import { EXCLUDE_INTERNAL_TRANSFER_SQL } from '../../../common/utils/internalTransfer';
import { toNumber } from '../../../common/utils/serializers';

export interface TenantRevenueRow {
  tenantId: string;
  revenue: number;
}

export interface TenantJobCountRow {
  tenantId: string;
  jobs: number;
}

export type GroupFinanceQueryOptions = {
  /** When set, skips the rollup existence probe for this request. */
  useRollup?: boolean;
};

export interface GroupRevenueTrendRow {
  label: string;
  [tenantCode: string]: number | string;
}

export async function groupRevenueByTenant(
  prisma: PrismaClient,
  tenantIds: string[],
  from: Date,
  to: Date,
  options?: GroupFinanceQueryOptions,
): Promise<TenantRevenueRow[]> {
  if (tenantIds.length === 0) return [];

  const useRollup =
    options?.useRollup ??
    (await hasDailyFinanceRollupForTenants(prisma, tenantIds, from, to));
  if (useRollup) {
    return groupRevenueByTenantFromRollup(prisma, tenantIds, from, to);
  }

  const rows = await prisma.$queryRaw<
    Array<{ tenantId: string; revenue: Prisma.Decimal | null }>
  >`
    SELECT "tenantId", COALESCE(SUM(amount), 0) AS revenue
    FROM "LedgerEntry"
    WHERE "deletedAt" IS NULL
      AND type = 'revenue'
      AND date >= ${from}
      AND date <= ${to}
      AND "tenantId" IN (${Prisma.join(tenantIds)})
      ${EXCLUDE_INTERNAL_TRANSFER_SQL}
    GROUP BY "tenantId"
  `;

  return rows.map((row) => ({
    tenantId: row.tenantId,
    revenue: toNumber(row.revenue ?? 0),
  }));
}

export async function groupJobsByTenant(
  prisma: PrismaClient,
  tenantIds: string[],
  from: Date,
  to: Date,
): Promise<TenantJobCountRow[]> {
  if (tenantIds.length === 0) return [];

  const rows = await prisma.$queryRaw<
    Array<{ tenantId: string; jobs: bigint }>
  >`
    SELECT "tenantId", COUNT(*)::bigint AS jobs
    FROM "Job"
    WHERE "deletedAt" IS NULL
      AND "createdAt" >= ${from}
      AND "createdAt" <= ${to}
      AND "tenantId" IN (${Prisma.join(tenantIds)})
    GROUP BY "tenantId"
  `;

  return rows.map((row) => ({
    tenantId: row.tenantId,
    jobs: Number(row.jobs),
  }));
}

export async function groupRevenueTrendByMonth(
  prisma: PrismaClient,
  tenantIds: string[],
  from: Date,
  to: Date,
  options?: GroupFinanceQueryOptions,
): Promise<
  Array<{ monthKey: string; label: string; tenantId: string; revenue: number }>
> {
  if (tenantIds.length === 0) return [];

  const useRollup =
    options?.useRollup ??
    (await hasDailyFinanceRollupForTenants(prisma, tenantIds, from, to));
  if (useRollup) {
    return groupRevenueTrendByMonthFromRollup(prisma, tenantIds, from, to);
  }

  const rows = await prisma.$queryRaw<
    Array<{
      monthKey: string;
      label: string;
      tenantId: string;
      revenue: Prisma.Decimal | null;
    }>
  >`
    SELECT
      to_char(date_trunc('month', date), 'YYYY-MM') AS "monthKey",
      to_char(date_trunc('month', date), 'Mon YY') AS label,
      "tenantId",
      COALESCE(SUM(amount), 0) AS revenue
    FROM "LedgerEntry"
    WHERE "deletedAt" IS NULL
      AND type = 'revenue'
      AND date >= ${from}
      AND date <= ${to}
      AND "tenantId" IN (${Prisma.join(tenantIds)})
      ${EXCLUDE_INTERNAL_TRANSFER_SQL}
    GROUP BY "monthKey", label, "tenantId"
    ORDER BY "monthKey" ASC
  `;

  return rows.map((row) => ({
    monthKey: row.monthKey,
    label: row.label.trim(),
    tenantId: row.tenantId,
    revenue: toNumber(row.revenue ?? 0),
  }));
}

export async function tenantStockValue(
  prisma: PrismaClient,
  tenantId: string,
): Promise<number> {
  const rows = await prisma.$queryRaw<[{ stock_value: Prisma.Decimal | null }]>`
    SELECT COALESCE(SUM(quantity * "costPrice"), 0) AS stock_value
    FROM "Item"
    WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
  `;
  return toNumber(rows[0]?.stock_value ?? 0);
}

export async function tenantTodaySalesRevenue(
  prisma: PrismaClient,
  tenantId: string,
  todayStart: Date,
  todayEnd: Date,
): Promise<{ revenue: number; returns: number }> {
  const rows = await prisma.$queryRaw<
    [{ revenue: Prisma.Decimal | null; returns: bigint }]
  >`
    SELECT
      COALESCE(SUM(total), 0) AS revenue,
      COUNT(*) FILTER (WHERE status IN ('refunded', 'partially_refunded', 'written_off'))::bigint AS returns
    FROM "Sale"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status::text <> 'draft'
      AND date >= ${todayStart}
      AND date <= ${todayEnd}
  `;
  const row = rows[0];
  return {
    revenue: toNumber(row?.revenue ?? 0),
    returns: Number(row?.returns ?? 0),
  };
}

export async function tenantTodayAppointmentStats(
  prisma: PrismaClient,
  tenantId: string,
  todayStart: Date,
  todayEnd: Date,
): Promise<{ count: number; revenue: number }> {
  const rows = await prisma.$queryRaw<
    [{ count: bigint; revenue: Prisma.Decimal | null }]
  >`
    SELECT
      COUNT(*)::bigint AS count,
      COALESCE(SUM("servicePrice"), 0) AS revenue
    FROM "Appointment"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND "startTime" >= ${todayStart}
      AND "startTime" <= ${todayEnd}
  `;
  const row = rows[0];
  return {
    count: Number(row?.count ?? 0),
    revenue: toNumber(row?.revenue ?? 0),
  };
}
