import type { LedgerEntryType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { toNumber } from './serializers';

type TenantDailyFinanceTenantFilter = string | { in: string[] };

type FinanceClient = {
  tenantDailyFinance: {
    count: (args: {
      where: {
        tenantId: TenantDailyFinanceTenantFilter;
        date?: { gte: Date; lte: Date };
      };
    }) => Promise<number>;
    findMany: (args: {
      where: {
        tenantId: string;
        date: { gte: Date; lte: Date };
      };
      orderBy: { date: 'asc' };
      select: {
        date: true;
        revenue: true;
        costs: true;
        expenses: true;
        currency: true;
      };
    }) => Promise<
      Array<{
        date: Date;
        revenue: Prisma.Decimal;
        costs: Prisma.Decimal;
        expenses: Prisma.Decimal;
        currency: string;
      }>
    >;
    upsert: (args: {
      where: { tenantId_date: { tenantId: string; date: Date } };
      create: {
        id: string;
        tenantId: string;
        date: Date;
        revenue: number;
        costs: number;
        expenses: number;
        net: number;
        currency: string;
      };
      update: {
        revenue: { increment: number };
        costs: { increment: number };
        expenses: { increment: number };
        net: { increment: number };
        currency: string;
      };
    }) => Promise<unknown>;
    aggregate: (args: {
      where: {
        tenantId: TenantDailyFinanceTenantFilter;
        date: { gte: Date; lte: Date };
      };
      _sum: {
        revenue: true;
        costs: true;
        expenses: true;
        net: true;
      };
    }) => Promise<{
      _sum: {
        revenue: Prisma.Decimal | null;
        costs: Prisma.Decimal | null;
        expenses: Prisma.Decimal | null;
        net: Prisma.Decimal | null;
      };
    }>;
  };
};

type LedgerBackfillClient = FinanceClient & {
  $queryRaw: <T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
  $executeRaw: (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<number>;
};

function dayStart(date: Date): Date {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

function rollupId(tenantId: string, date: Date): string {
  return `${tenantId}:${dayStart(date).toISOString().slice(0, 10)}`;
}

function deltaForType(type: LedgerEntryType, amount: number) {
  return {
    revenue: type === 'revenue' ? amount : 0,
    costs: type === 'cost' ? amount : 0,
    expenses: type === 'expense' ? amount : 0,
    net:
      type === 'revenue'
        ? amount
        : type === 'cost' || type === 'expense'
          ? -amount
          : 0,
  };
}

export async function applyDailyFinanceDelta(
  db: FinanceClient,
  tenantId: string,
  date: Date,
  type: LedgerEntryType,
  amount: number,
  currency = 'NGN',
): Promise<void> {
  const day = dayStart(date);
  const delta = deltaForType(type, amount);

  await db.tenantDailyFinance.upsert({
    where: { tenantId_date: { tenantId, date: day } },
    create: {
      id: rollupId(tenantId, day),
      tenantId,
      date: day,
      revenue: delta.revenue,
      costs: delta.costs,
      expenses: delta.expenses,
      net: delta.net,
      currency,
    },
    update: {
      revenue: { increment: delta.revenue },
      costs: { increment: delta.costs },
      expenses: { increment: delta.expenses },
      net: { increment: delta.net },
      currency,
    },
  });
}

export async function sumDailyFinanceRollup(
  db: FinanceClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<{
  revenue: number;
  costs: number;
  expenses: number;
  net: number;
}> {
  const agg = await db.tenantDailyFinance.aggregate({
    where: {
      tenantId,
      date: { gte: dayStart(from), lte: dayStart(to) },
    },
    _sum: {
      revenue: true,
      costs: true,
      expenses: true,
      net: true,
    },
  });

  return {
    revenue: Number(agg._sum.revenue ?? 0),
    costs: Number(agg._sum.costs ?? 0),
    expenses: Number(agg._sum.expenses ?? 0),
    net: Number(agg._sum.net ?? 0),
  };
}

/** True when any daily rollup row exists for the tenant in the window. */
export async function hasDailyFinanceRollup(
  db: FinanceClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<boolean> {
  const count = await db.tenantDailyFinance.count({
    where: {
      tenantId,
      date: { gte: dayStart(from), lte: dayStart(to) },
    },
  });
  return count > 0;
}

/** Single probe per request — reuse for revenue + trend queries. */
export async function resolveGroupFinanceSource(
  db: FinanceClient,
  tenantIds: string[],
  from: Date,
  to: Date,
): Promise<boolean> {
  return hasDailyFinanceRollupForTenants(db, tenantIds, from, to);
}

/** True when any tenant in the set has rollup rows in the window. */
export async function hasDailyFinanceRollupForTenants(
  db: FinanceClient,
  tenantIds: string[],
  from: Date,
  to: Date,
): Promise<boolean> {
  if (tenantIds.length === 0) return false;
  const count = await db.tenantDailyFinance.count({
    where: {
      tenantId: { in: tenantIds },
      date: { gte: dayStart(from), lte: dayStart(to) },
    },
  });
  return count > 0;
}

/** Sum revenue/costs/expenses/net across multiple tenants from daily rollups. */
export async function sumDailyFinanceRollupForTenants(
  db: FinanceClient,
  tenantIds: string[],
  from: Date,
  to: Date,
): Promise<{
  revenue: number;
  costs: number;
  expenses: number;
  net: number;
}> {
  if (tenantIds.length === 0) {
    return { revenue: 0, costs: 0, expenses: 0, net: 0 };
  }
  const agg = await db.tenantDailyFinance.aggregate({
    where: {
      tenantId: { in: tenantIds },
      date: { gte: dayStart(from), lte: dayStart(to) },
    },
    _sum: {
      revenue: true,
      costs: true,
      expenses: true,
      net: true,
    },
  });
  return {
    revenue: Number(agg._sum.revenue ?? 0),
    costs: Number(agg._sum.costs ?? 0),
    expenses: Number(agg._sum.expenses ?? 0),
    net: Number(agg._sum.net ?? 0),
  };
}

type GroupRollupClient = {
  $queryRaw: <T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
};

/** Per-tenant revenue from TenantDailyFinance (group overview KPIs). */
export async function groupRevenueByTenantFromRollup(
  db: GroupRollupClient,
  tenantIds: string[],
  from: Date,
  to: Date,
): Promise<Array<{ tenantId: string; revenue: number }>> {
  if (tenantIds.length === 0) return [];

  const rows = await db.$queryRaw<
    Array<{ tenantId: string; revenue: Prisma.Decimal | null }>
  >`
    SELECT "tenantId", COALESCE(SUM(revenue), 0) AS revenue
    FROM "TenantDailyFinance"
    WHERE "tenantId" IN (${Prisma.join(tenantIds)})
      AND date >= ${dayStart(from)}
      AND date <= ${dayStart(to)}
    GROUP BY "tenantId"
  `;

  return rows.map((row) => ({
    tenantId: row.tenantId,
    revenue: Number(row.revenue ?? 0),
  }));
}

/** Monthly per-tenant revenue trend from TenantDailyFinance. */
export async function groupRevenueTrendByMonthFromRollup(
  db: GroupRollupClient,
  tenantIds: string[],
  from: Date,
  to: Date,
): Promise<
  Array<{ monthKey: string; label: string; tenantId: string; revenue: number }>
> {
  if (tenantIds.length === 0) return [];

  const rows = await db.$queryRaw<
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
      COALESCE(SUM(revenue), 0) AS revenue
    FROM "TenantDailyFinance"
    WHERE "tenantId" IN (${Prisma.join(tenantIds)})
      AND date >= ${dayStart(from)}
      AND date <= ${dayStart(to)}
    GROUP BY "monthKey", label, "tenantId"
    ORDER BY "monthKey" ASC
  `;

  return rows.map((row) => ({
    monthKey: row.monthKey,
    label: row.label.trim(),
    tenantId: row.tenantId,
    revenue: Number(row.revenue ?? 0),
  }));
}


/** Per-tenant finance totals from TenantDailyFinance (group ledger by-entity). */
export async function groupFinanceByTenantFromRollup(
  db: GroupRollupClient,
  tenantIds: string[],
  from: Date,
  to: Date,
): Promise<
  Array<{
    tenantId: string;
    revenue: number;
    costs: number;
    expenses: number;
    net: number;
  }>
> {
  if (tenantIds.length === 0) return [];

  const rows = await db.$queryRaw<
    Array<{
      tenantId: string;
      revenue: Prisma.Decimal | null;
      costs: Prisma.Decimal | null;
      expenses: Prisma.Decimal | null;
      net: Prisma.Decimal | null;
    }>
  >`
    SELECT "tenantId",
      COALESCE(SUM(revenue), 0) AS revenue,
      COALESCE(SUM(costs), 0) AS costs,
      COALESCE(SUM(expenses), 0) AS expenses,
      COALESCE(SUM(net), 0) AS net
    FROM "TenantDailyFinance"
    WHERE "tenantId" IN (${Prisma.join(tenantIds)})
      AND date >= ${dayStart(from)}
      AND date <= ${dayStart(to)}
    GROUP BY "tenantId"
  `;

  return rows.map((row) => ({
    tenantId: row.tenantId,
    revenue: Number(row.revenue ?? 0),
    costs: Number(row.costs ?? 0),
    expenses: Number(row.expenses ?? 0),
    net: Number(row.net ?? 0),
  }));
}

/** Daily P&L trend aggregated across tenants (group ledger charts). */
export async function groupDailyFinanceTrend(
  db: GroupRollupClient,
  tenantIds: string[],
  from: Date,
  to: Date,
): Promise<Array<{ label: string; revenue: number; costs: number }>> {
  if (tenantIds.length === 0) {
    return [{ label: '—', revenue: 0, costs: 0 }];
  }

  const rows = await db.$queryRaw<
    Array<{
      date: Date;
      revenue: Prisma.Decimal | null;
      costs: Prisma.Decimal | null;
      expenses: Prisma.Decimal | null;
    }>
  >`
    SELECT date,
      COALESCE(SUM(revenue), 0) AS revenue,
      COALESCE(SUM(costs), 0) AS costs,
      COALESCE(SUM(expenses), 0) AS expenses
    FROM "TenantDailyFinance"
    WHERE "tenantId" IN (${Prisma.join(tenantIds)})
      AND date >= ${dayStart(from)}
      AND date <= ${dayStart(to)}
    GROUP BY date
    ORDER BY date ASC
  `;

  if (rows.length === 0) {
    return [{ label: '—', revenue: 0, costs: 0 }];
  }

  return rows.map((row) => ({
    label: dayStart(row.date).toISOString().slice(0, 10),
    revenue: Number(row.revenue ?? 0),
    costs: Number(row.costs ?? 0) + Number(row.expenses ?? 0),
  }));
}

export async function dailyFinanceTrend(
  db: FinanceClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<Array<{ label: string; revenue: number; costs: number }>> {
  const rows = await db.tenantDailyFinance.findMany({
    where: {
      tenantId,
      date: { gte: dayStart(from), lte: dayStart(to) },
    },
    orderBy: { date: 'asc' },
    select: {
      date: true,
      revenue: true,
      costs: true,
      expenses: true,
      currency: true,
    },
  });

  if (rows.length === 0) {
    return [{ label: '—', revenue: 0, costs: 0 }];
  }

  return rows.map((row) => ({
    label: dayStart(row.date).toISOString().slice(0, 10),
    revenue: toNumber(row.revenue),
    costs: toNumber(row.costs) + toNumber(row.expenses),
  }));
}

/**
 * Rebuild TenantDailyFinance for one tenant (or all) from LedgerEntry.
 * Safe to re-run: deletes existing rollup rows for the scope then inserts aggregates.
 */
export async function backfillDailyFinanceFromLedger(
  db: LedgerBackfillClient,
  tenantId?: string,
): Promise<number> {
  if (tenantId) {
    await db.$executeRaw`
      DELETE FROM "TenantDailyFinance" WHERE "tenantId" = ${tenantId}
    `;
  } else {
    await db.$executeRaw`DELETE FROM "TenantDailyFinance"`;
  }

  if (tenantId) {
    const result = await db.$executeRaw`
      INSERT INTO "TenantDailyFinance" (
        id, "tenantId", date, revenue, costs, expenses, net, currency, "updatedAt"
      )
      SELECT
        ("tenantId" || ':' || to_char(date_trunc('day', date AT TIME ZONE 'UTC'), 'YYYY-MM-DD')),
        "tenantId",
        (date_trunc('day', date AT TIME ZONE 'UTC'))::date,
        COALESCE(SUM(CASE WHEN type = 'revenue' THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN type = 'cost' THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0),
        COALESCE(SUM(
          CASE
            WHEN type = 'revenue' THEN amount
            WHEN type IN ('cost', 'expense') THEN -amount
            ELSE 0
          END
        ), 0),
        COALESCE(MAX(currency), 'NGN'),
        NOW()
      FROM "LedgerEntry"
      WHERE "deletedAt" IS NULL
        AND "tenantId" = ${tenantId}
      GROUP BY "tenantId", date_trunc('day', date AT TIME ZONE 'UTC')
    `;
    return Number(result);
  }

  const result = await db.$executeRaw`
    INSERT INTO "TenantDailyFinance" (
      id, "tenantId", date, revenue, costs, expenses, net, currency, "updatedAt"
    )
    SELECT
      ("tenantId" || ':' || to_char(date_trunc('day', date AT TIME ZONE 'UTC'), 'YYYY-MM-DD')),
      "tenantId",
      (date_trunc('day', date AT TIME ZONE 'UTC'))::date,
      COALESCE(SUM(CASE WHEN type = 'revenue' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN type = 'cost' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(
        CASE
          WHEN type = 'revenue' THEN amount
          WHEN type IN ('cost', 'expense') THEN -amount
          ELSE 0
        END
      ), 0),
      COALESCE(MAX(currency), 'NGN'),
      NOW()
    FROM "LedgerEntry"
    WHERE "deletedAt" IS NULL
    GROUP BY "tenantId", date_trunc('day', date AT TIME ZONE 'UTC')
  `;
  return Number(result);
}
