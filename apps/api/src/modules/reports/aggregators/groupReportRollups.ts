import type {
  ReportRegistryEntry,
  ReportsDashboard,
  ReportsKpi,
} from '@vonos/types';
import type { PrismaClient } from '@prisma/client';
import { ledgerDateFilter } from '../../../common/utils/ledgerAggregates';
import { mapPool, runPool } from '../../../common/utils/mapPool';
import { toNumber } from '../../../common/utils/serializers';
import { resolveDateWindow } from './date-utils';
import { tenantStockValue } from './groupReportQueries';

const NEON_QUERY_CONCURRENCY = 2;

export interface GroupEntityRollupRow {
  code: string;
  rows: Record<string, string | number>[];
}

function humanizeKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (char) => char.toUpperCase())
    .trim();
}

function sumField(
  byEntity: GroupEntityRollupRow[],
  field: string,
): number {
  return byEntity.reduce((sum, entity) => {
    const value = entity.rows[0]?.[field];
    return sum + (typeof value === 'number' ? value : Number(value ?? 0));
  }, 0);
}

function chartMetricForReport(entry: ReportRegistryEntry): {
  field: string;
  label: string;
  currency?: string;
} {
  switch (entry.id) {
    case 'profit-loss':
    case 'expense':
      return { field: 'net', label: 'Net', currency: 'NGN' };
    case 'stock':
      return { field: 'stockValue', label: 'Stock value', currency: 'NGN' };
    case 'low-stock':
      return { field: 'lowStock', label: 'Low / out SKUs' };
    case 'supplier-customer':
    case 'customer-groups':
      return { field: 'customers', label: 'Customers' };
    case 'purchase-payment':
    case 'sell-payment':
      return { field: 'amount', label: 'Payments', currency: 'NGN' };
    case 'tax':
    case 'purchase-sale':
    case 'register':
    case 'sales-rep':
    case 'service-staff':
    case 'trending':
    case 'product-sell':
    case 'product-purchase':
    case 'items':
      return { field: 'salesRevenue', label: 'Sales revenue', currency: 'NGN' };
    default:
      return { field: 'revenue', label: 'Revenue', currency: 'NGN' };
  }
}

/** Shape a group roll-up into a per-report dashboard (not the generic group overview). */
export function dashboardFromGroupRollup(
  entry: ReportRegistryEntry,
  byEntity: GroupEntityRollupRow[],
): ReportsDashboard {
  const metric = chartMetricForReport(entry);
  const tableRows = byEntity.flatMap((entity) =>
    entity.rows.map((row, index) => ({
      id: `${entity.code}-${index}`,
      entity: entity.code,
      ...row,
    })),
  );
  const sample = byEntity[0]?.rows[0];
  const columns = [
    { key: 'entity', header: 'Entity' },
    ...(sample
      ? Object.keys(sample).map((key) => ({
          key,
          header: humanizeKey(key),
        }))
      : [{ key: metric.field, header: metric.label }]),
  ];

  const kpis: ReportsKpi[] = [
    {
      label: `Group ${metric.label}`,
      icon: 'wallet',
      metricKey: metric.field,
      color: '#059669',
      value: Math.round(sumField(byEntity, metric.field)),
      ...(metric.currency ? { currency: metric.currency } : {}),
    },
    {
      label: 'Entities',
      icon: 'package',
      metricKey: 'entities',
      color: '#9333ea',
      value: byEntity.length,
    },
  ];

  if (entry.id === 'profit-loss' || entry.id === 'expense') {
    kpis.push(
      {
        label: 'Group revenue',
        icon: 'trending-up',
        metricKey: 'revenue',
        color: '#2563eb',
        value: Math.round(sumField(byEntity, 'revenue')),
        currency: 'NGN',
      },
      {
        label: 'Group costs',
        icon: 'receipt',
        metricKey: 'costs',
        color: '#e11d48',
        value: Math.round(sumField(byEntity, 'costs')),
        currency: 'NGN',
      },
    );
  } else if (entry.id === 'stock') {
    kpis.push(
      {
        label: 'Total SKUs',
        icon: 'package',
        metricKey: 'skuCount',
        color: '#2563eb',
        value: Math.round(sumField(byEntity, 'skuCount')),
      },
      {
        label: 'Low / out',
        icon: 'alert-triangle',
        metricKey: 'lowStock',
        color: '#f59e0b',
        value: Math.round(sumField(byEntity, 'lowStock')),
      },
    );
  } else if (entry.id === 'low-stock') {
    kpis.push({
      label: 'Total SKUs',
      icon: 'package',
      metricKey: 'skuCount',
      color: '#2563eb',
      value: Math.round(sumField(byEntity, 'skuCount')),
    });
  } else if (
    entry.id === 'supplier-customer' ||
    entry.id === 'customer-groups'
  ) {
    kpis.push({
      label: 'Suppliers',
      icon: 'truck',
      metricKey: 'suppliers',
      color: '#0d9488',
      value: Math.round(sumField(byEntity, 'suppliers')),
    });
  } else if (entry.source.kind === 'sales' || entry.source.kind === 'product') {
    kpis.push(
      {
        label: 'Transactions',
        icon: 'shopping-cart',
        metricKey: 'transactions',
        color: '#2563eb',
        value: Math.round(sumField(byEntity, 'transactions')),
      },
      {
        label: 'Jobs',
        icon: 'wrench',
        metricKey: 'jobs',
        color: '#D97706',
        value: Math.round(sumField(byEntity, 'jobs')),
      },
    );
  } else if (entry.source.kind === 'payments') {
    kpis.push({
      label: 'Payment count',
      icon: 'credit-card',
      metricKey: 'payments',
      color: '#2563eb',
      value: Math.round(sumField(byEntity, 'payments')),
    });
  }

  const chartData = byEntity
    .map((entity) => {
      const raw = entity.rows[0]?.[metric.field];
      const value = typeof raw === 'number' ? raw : Number(raw ?? 0);
      return {
        label: entity.code,
        value: metric.currency ? Math.round(value / 1000) : Math.round(value),
      };
    })
    .sort((a, b) => b.value - a.value);

  return {
    kpis,
    charts: [
      {
        id: `group-${entry.id}-by-entity`,
        title: `${entry.label} by entity`,
        subtitle: metric.currency
          ? `${metric.label} ranking (₦ thousands)`
          : `${metric.label} ranking`,
        type: 'bar',
        horizontal: true,
        series: [
          {
            name: metric.label,
            dataKey: 'value',
            color: '#059669',
          },
        ],
        data: chartData,
      },
    ],
    table: {
      columns,
      rows: tableRows,
    },
    byEntity: byEntity.map((entity) => ({
      code: entity.code,
      rows: entity.rows,
    })),
  };
}

export async function buildEntityRollupForReport(
  prisma: PrismaClient,
  entry: ReportRegistryEntry,
  tenants: Array<{ id: string; code: string; archetype: string }>,
  from?: string,
  to?: string,
): Promise<GroupEntityRollupRow[]> {
  const window = resolveDateWindow(from, to);
  const dateFilter = ledgerDateFilter(from, to);
  const source = entry.source;

  switch (source.kind) {
    case 'ledger': {
      return mapPool(tenants, NEON_QUERY_CONCURRENCY, async (tenant) => {
          const groups = await prisma.ledgerEntry.groupBy({
            by: ['type'],
            where: {
              tenantId: tenant.id,
              deletedAt: null,
              isInternalTransfer: false,
              ...dateFilter,
            },
            _sum: { amount: true },
          });
          const revenue = groups
            .filter((g) => g.type === 'revenue')
            .reduce((s, g) => s + toNumber(g._sum.amount ?? 0), 0);
          const costs = groups
            .filter((g) => g.type !== 'revenue')
            .reduce((s, g) => s + toNumber(g._sum.amount ?? 0), 0);
          return {
            code: tenant.code,
            rows: [{ revenue, costs, net: revenue - costs }],
          };
        });
    }
    case 'stock': {
      return mapPool(tenants, NEON_QUERY_CONCURRENCY, async (tenant) => {
          const [stockValue, lowStock, skuCount] = await runPool(
            [
              () => tenantStockValue(prisma, tenant.id),
              () =>
                prisma.item.count({
                  where: {
                    tenantId: tenant.id,
                    deletedAt: null,
                    status: { in: ['low_stock', 'out_of_stock'] },
                  },
                }),
              () =>
                prisma.item.count({
                  where: { tenantId: tenant.id, deletedAt: null },
                }),
            ],
            NEON_QUERY_CONCURRENCY,
          );
          if (source.handler === 'lowstock') {
            return {
              code: tenant.code,
              rows: [{ lowStock, skuCount }],
            };
          }
          return {
            code: tenant.code,
            rows: [
              {
                stockValue: Math.round(stockValue),
                lowStock,
                skuCount,
              },
            ],
          };
        });
    }
    case 'product':
    case 'sales': {
      return mapPool(tenants, NEON_QUERY_CONCURRENCY, async (tenant) => {
          const [salesAgg, jobAgg] = await runPool(
            [
              () =>
                prisma.sale.aggregate({
                  where: {
                    tenantId: tenant.id,
                    deletedAt: null,
                    status: { not: 'draft' },
                    date: { gte: window.from, lte: window.to },
                  },
                  _sum: { total: true },
                  _count: { _all: true },
                }),
              () =>
                prisma.job.aggregate({
                  where: {
                    tenantId: tenant.id,
                    deletedAt: null,
                    status: 'Delivered',
                    updatedAt: { gte: window.from, lte: window.to },
                  },
                  _sum: { invoiceAmount: true, quoteAmount: true },
                  _count: { _all: true },
                }),
            ],
            NEON_QUERY_CONCURRENCY,
          );
          const salesRevenue = toNumber(salesAgg._sum.total ?? 0);
          const jobRevenue = Math.max(
            toNumber(jobAgg._sum.invoiceAmount ?? 0),
            toNumber(jobAgg._sum.quoteAmount ?? 0),
          );
          return {
            code: tenant.code,
            rows: [
              {
                salesRevenue: Math.round(salesRevenue),
                jobRevenue: Math.round(jobRevenue),
                transactions: salesAgg._count._all,
                jobs: jobAgg._count._all,
              },
            ],
          };
        });
    }
    case 'payments': {
      return mapPool(tenants, NEON_QUERY_CONCURRENCY, async (tenant) => {
          const agg = await prisma.payment.aggregate({
            where: {
              tenantId: tenant.id,
              deletedAt: null,
              paidOn: { gte: window.from, lte: window.to },
            },
            _sum: { amount: true },
            _count: { _all: true },
          });
          return {
            code: tenant.code,
            rows: [
              {
                payments: agg._count._all,
                amount: Math.round(toNumber(agg._sum.amount ?? 0)),
              },
            ],
          };
        });
    }
    case 'contacts': {
      return mapPool(tenants, NEON_QUERY_CONCURRENCY, async (tenant) => {
          const [customers, suppliers] = await runPool(
            [
              () =>
                prisma.customer.count({
                  where: { tenantId: tenant.id, deletedAt: null },
                }),
              () =>
                prisma.supplier.count({
                  where: { tenantId: tenant.id, deletedAt: null },
                }),
            ],
            NEON_QUERY_CONCURRENCY,
          );
          return {
            code: tenant.code,
            rows: [{ customers, suppliers }],
          };
        });
    }
  }

  return [];
}
