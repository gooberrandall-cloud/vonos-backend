import type { ReportsDashboard } from '@vonos/types';
import { AUTOS_GROUP_CODES } from '@vonos/types';
import type { PrismaClient } from '@prisma/client';
import {
  resolveGroupFinanceSource,
  sumDailyFinanceRollupForTenants,
} from '../../../common/utils/dailyFinanceRollup';
import { runPool } from '../../../common/utils/mapPool';
import { toNumber } from '../../../common/utils/serializers';
import { resolveDateWindow } from './date-utils';
import {
  groupJobsByTenant,
  groupRevenueByTenant,
  groupRevenueTrendByMonth,
  type GroupFinanceQueryOptions,
} from './groupReportQueries';

const NEON_QUERY_CONCURRENCY = 2;

const ENTITY_COLORS: Record<string, string> = {
  VW: '#059669',
  VKW: '#ec4899',
  VISP: '#14b8a6',
  VSP: '#0d9488',
  VC: '#f59e0b',
  VM: '#D97706',
  VMS: '#B45309',
  VS: '#e11d48',
};

export type GroupTenantRow = {
  id: string;
  code: string;
  name: string;
};

async function loadGroupTenants(prisma: PrismaClient): Promise<GroupTenantRow[]> {
  return prisma.tenant.findMany({
    where: { code: { in: [...AUTOS_GROUP_CODES] }, deletedAt: null },
    select: { id: true, code: true, name: true },
  });
}

/** Core strip KPIs only — no charts / secondary aggregates. */
export async function buildGroupCoreKpis(
  prisma: PrismaClient,
  from?: string,
  to?: string,
  tenants?: GroupTenantRow[],
  financeOptions?: GroupFinanceQueryOptions,
): Promise<{
  kpis: ReportsDashboard['kpis'];
  tenants: GroupTenantRow[];
  revenueByTenant: Map<string, number>;
  jobsByTenant: Map<string, number>;
}> {
  const window = resolveDateWindow(from, to);
  const groupTenants = tenants ?? (await loadGroupTenants(prisma));
  const tenantIds = groupTenants.map((t) => t.id);

  const [revenueRows, jobRows] = await runPool(
    [
      () =>
        groupRevenueByTenant(
          prisma,
          tenantIds,
          window.from,
          window.to,
          financeOptions,
        ),
      () => groupJobsByTenant(prisma, tenantIds, window.from, window.to),
    ],
    NEON_QUERY_CONCURRENCY,
  );

  const revenueByTenant = new Map(
    revenueRows.map((row) => [row.tenantId, row.revenue]),
  );
  const jobsByTenant = new Map(jobRows.map((row) => [row.tenantId, row.jobs]));

  const groupRevenue = revenueRows.reduce((sum, row) => sum + row.revenue, 0);
  const totalJobs = jobRows.reduce((sum, row) => sum + row.jobs, 0);

  return {
    tenants: groupTenants,
    revenueByTenant,
    jobsByTenant,
    kpis: [
      {
        label: 'Group Revenue',
        icon: 'wallet',
        metricKey: 'revenue',
        color: '#059669',
        value: groupRevenue,
        currency: 'NGN',
      },
      {
        label: 'Total Jobs',
        icon: 'wrench',
        metricKey: 'jobs',
        color: '#2563eb',
        value: totalJobs,
      },
      {
        label: 'Active Entities',
        icon: 'package',
        metricKey: 'entities',
        color: '#9333ea',
        value: groupTenants.length,
      },
      {
        label: 'Outstanding',
        icon: 'clock',
        metricKey: 'outstanding',
        color: '#e11d48',
        value: 0,
      },
    ],
  };
}

export async function buildGroupCharts(
  prisma: PrismaClient,
  from?: string,
  to?: string,
  tenants?: GroupTenantRow[],
  revenueByTenant?: Map<string, number>,
  financeOptions?: GroupFinanceQueryOptions,
): Promise<ReportsDashboard['charts']> {
  const window = resolveDateWindow(from, to);
  const groupTenants = tenants ?? (await loadGroupTenants(prisma));
  const tenantById = new Map(groupTenants.map((t) => [t.id, t]));
  const tenantIds = groupTenants.map((t) => t.id);

  const financeOpts = financeOptions;
  const [trendRows, revenueRows] = await runPool(
    [
      () =>
        groupRevenueTrendByMonth(
          prisma,
          tenantIds,
          window.from,
          window.to,
          financeOpts,
        ),
      () =>
        revenueByTenant
          ? Promise.resolve(
              [...revenueByTenant.entries()].map(([tenantId, revenue]) => ({
                tenantId,
                revenue,
              })),
            )
          : groupRevenueByTenant(
              prisma,
              tenantIds,
              window.from,
              window.to,
              financeOpts,
            ),
    ],
    NEON_QUERY_CONCURRENCY,
  );

  const revenueMap =
    revenueByTenant ??
    new Map(revenueRows.map((row) => [row.tenantId, row.revenue]));

  const monthSeries = new Map<
    string,
    { label: string } & Record<string, number | string>
  >();
  for (const row of trendRows) {
    const tenant = tenantById.get(row.tenantId);
    if (!tenant) continue;
    const existing = monthSeries.get(row.monthKey) ?? { label: row.label };
    existing[tenant.code] = Number(existing[tenant.code] ?? 0) + row.revenue;
    monthSeries.set(row.monthKey, existing);
  }

  const trendData = Array.from(monthSeries.values()).sort((a, b) =>
    String(a.label).localeCompare(String(b.label)),
  );

  const entitySeries = groupTenants.map((t) => ({
    name: t.code,
    dataKey: t.code,
    color: ENTITY_COLORS[t.code] ?? '#64748b',
  }));

  const rankingData = groupTenants
    .map((t) => ({
      label: t.code,
      value: Math.round((revenueMap.get(t.id) ?? 0) / 1000),
      color: ENTITY_COLORS[t.code] ?? '#64748b',
    }))
    .sort((a, b) => b.value - a.value);

  return [
    {
      id: 'group-revenue-trend',
      title: 'Group Revenue Trend',
      subtitle:
        'One line per entity — transfer elimination between entities is deferred',
      type: 'line',
      series: entitySeries,
      data: trendData.length > 0 ? trendData : [{ label: '—', VW: 0 }],
    },
    {
      id: 'entity-comparison',
      title: 'Entity Comparison',
      subtitle: 'Revenue ranking for period (₦ thousands)',
      type: 'bar',
      horizontal: true,
      series: [{ name: 'Revenue', dataKey: 'value', color: '#059669' }],
      data: rankingData,
    },
  ];
}

export async function buildGroupReports(
  prisma: PrismaClient,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const tenants = await loadGroupTenants(prisma);
  const tenantIds = tenants.map((t) => t.id);

  const useRollup = await resolveGroupFinanceSource(
    prisma,
    tenantIds,
    window.from,
    window.to,
  );
  const financeOptions = { useRollup };
  const core = await buildGroupCoreKpis(
    prisma,
    from,
    to,
    tenants,
    financeOptions,
  );

  const [charts, purchasesExpenses, movementCount, lowStockCount] =
    await runPool(
      [
        () =>
          buildGroupCharts(
            prisma,
            from,
            to,
            tenants,
            core.revenueByTenant,
            financeOptions,
          ),
        () =>
          (useRollup
            ? sumDailyFinanceRollupForTenants(
                prisma,
                tenantIds,
                window.from,
                window.to,
              )
            : runPool(
                [
                  () =>
                    prisma.ledgerEntry.aggregate({
                      where: {
                        tenantId: { in: tenantIds },
                        deletedAt: null,
                        isInternalTransfer: false,
                        type: 'cost',
                        date: { gte: window.from, lte: window.to },
                      },
                      _sum: { amount: true },
                    }),
                  () =>
                    prisma.ledgerEntry.aggregate({
                      where: {
                        tenantId: { in: tenantIds },
                        deletedAt: null,
                        isInternalTransfer: false,
                        type: 'expense',
                        date: { gte: window.from, lte: window.to },
                      },
                      _sum: { amount: true },
                    }),
                ],
                NEON_QUERY_CONCURRENCY,
              ).then(([purchasesAgg, expensesAgg]) => ({
                costs: toNumber(purchasesAgg._sum.amount),
                expenses: toNumber(expensesAgg._sum.amount),
              }))) as Promise<{ costs: number; expenses: number }>,
        () =>
          prisma.stockMovement.count({
            where: {
              tenantId: { in: tenantIds },
              deletedAt: null,
              date: { gte: window.from, lte: window.to },
            },
          }),
        () =>
          prisma.item.count({
            where: {
              tenantId: { in: tenantIds },
              deletedAt: null,
              status: { in: ['low_stock', 'out_of_stock'] },
            },
          }),
      ],
      NEON_QUERY_CONCURRENCY,
    );

  const totalPurchases = purchasesExpenses.costs;
  const totalExpenses = purchasesExpenses.expenses;

  const entityTableRows = tenants
    .map((t) => ({
      id: t.code,
      tenantCode: t.code,
      tenantName: t.name,
      revenue: Math.round(core.revenueByTenant.get(t.id) ?? 0),
      jobs: core.jobsByTenant.get(t.id) ?? 0,
      currency: 'NGN',
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    kpis: [
      ...core.kpis,
      {
        label: 'Total Purchases',
        icon: 'shopping-cart',
        metricKey: 'purchases',
        color: '#0d9488',
        value: totalPurchases,
        currency: 'NGN',
      },
      {
        label: 'Total Expenses',
        icon: 'receipt',
        metricKey: 'expenses',
        color: '#e11d48',
        value: totalExpenses,
        currency: 'NGN',
      },
      {
        label: 'Stock Movements',
        icon: 'truck',
        metricKey: 'movements',
        color: '#2563eb',
        value: movementCount,
      },
      {
        label: 'Low / Out of Stock',
        icon: 'alert-triangle',
        metricKey: 'lowStock',
        color: '#f59e0b',
        value: lowStockCount,
      },
    ],
    charts,
    table: {
      columns: [
        { key: 'tenantCode', header: 'Entity' },
        { key: 'tenantName', header: 'Department' },
        { key: 'revenue', header: 'Revenue' },
        { key: 'jobs', header: 'Jobs' },
      ],
      rows: entityTableRows,
    },
  };
}
