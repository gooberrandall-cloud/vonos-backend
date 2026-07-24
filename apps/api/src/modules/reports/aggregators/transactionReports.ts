import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { runPool } from '../../../common/utils/mapPool';
import { computeDelta, priorWindow, resolveDateWindow, asChartData } from './date-utils';
import {
  hourlyOrderCounts,
  paymentStatusBreakdown,
  salesKpiSnapshot,
  salesRevenueTrend,
  topProductsInWindow,
} from './salesReportQueries';

type TransactionTab = 'sales' | 'closeout';

const NEON_QUERY_CONCURRENCY = 2;

export async function buildTransactionReports(
  db: TenantScopedPrisma,
  tenantId: string,
  tab: TransactionTab,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);

  const [period, priorPeriod, trendData, topProducts] = await runPool(
    [
      () => salesKpiSnapshot(db, tenantId, window.from, window.to),
      () => salesKpiSnapshot(db, tenantId, prior.from, prior.to),
      () => salesRevenueTrend(db, tenantId, window),
      () =>
        tab === 'sales'
          ? topProductsInWindow(db, tenantId, window.from, window.to, 12)
          : Promise.resolve([]),
    ],
    NEON_QUERY_CONCURRENCY,
  );

  const {
    transactionCount,
    revenue,
    refundedCount,
    currency,
  } = period;
  const priorCount = priorPeriod.transactionCount;
  const priorRevenue = priorPeriod.revenue;
  const avgTicket = transactionCount > 0 ? revenue / transactionCount : 0;
  const priorAvg = priorCount > 0 ? priorRevenue / priorCount : 0;

  const topByUnits = topProducts.map((row) => ({
    label: row.label,
    units: Math.round(row.units * 100) / 100,
  }));
  const topByRevenue = topProducts.map((row) => ({
    label: row.label,
    revenue: Math.round(row.revenue),
  }));

  if (tab === 'sales') {
    return {
      kpis: [
        {
          label: 'Revenue',
          icon: 'wallet',
          metricKey: 'revenue',
          color: '#059669',
          value: revenue,
          currency,
          ...computeDelta(revenue, priorRevenue),
        },
        {
          label: 'Transactions',
          icon: 'receipt',
          metricKey: 'transactionCount',
          color: '#2563eb',
          value: transactionCount,
          ...computeDelta(transactionCount, priorCount),
        },
        {
          label: 'Avg Ticket',
          icon: 'calculator',
          metricKey: 'avgTicket',
          color: '#9333ea',
          value: Math.round(avgTicket),
          currency,
          ...computeDelta(avgTicket, priorAvg),
        },
        {
          label: 'Refunds',
          icon: 'rotate-ccw',
          metricKey: 'refundedCount',
          color: '#e11d48',
          value: refundedCount,
        },
      ],
      charts: [
        {
          id: 'sales-trend',
          title: 'Sales Trend',
          subtitle: 'Revenue over selected period',
          type: 'line',
          series: [{ name: 'Revenue', dataKey: 'revenue', color: '#059669' }],
          data: trendData.length > 0 ? asChartData(trendData) : asChartData([{ label: '—', revenue: 0 }]),
        },
        {
          id: 'top-products-units',
          title: 'Top Products',
          subtitle: 'Units sold in selected period',
          type: 'bar',
          horizontal: true,
          series: [{ name: 'Units', dataKey: 'units', color: '#3b82f6' }],
          data: topByUnits.length > 0 ? topByUnits : [{ label: '—', units: 0 }],
        },
        {
          id: 'top-products-revenue',
          title: 'Top Products by Revenue',
          subtitle: 'Line revenue in selected period',
          type: 'bar',
          horizontal: true,
          series: [{ name: 'Revenue', dataKey: 'revenue', color: '#059669' }],
          data:
            topByRevenue.length > 0
              ? topByRevenue
              : [{ label: '—', revenue: 0 }],
        },
      ],
      table:
        topProducts.length > 0
          ? {
              columns: [
                { key: 'sku', header: 'SKU' },
                { key: 'name', header: 'Product' },
                { key: 'units', header: 'Units Sold' },
                { key: 'revenue', header: 'Revenue' },
              ],
              rows: topProducts.map((row) => ({
                id: row.itemId ?? row.sku,
                recordType: row.itemId ? 'item' : '',
                sku: row.sku,
                name: row.label,
                units: Math.round(row.units * 100) / 100,
                revenue: Math.round(row.revenue),
                currency,
              })),
              columnTotals: {
                units:
                  Math.round(
                    topProducts.reduce((s, r) => s + r.units, 0) * 100,
                  ) / 100,
                revenue: Math.round(
                  topProducts.reduce((s, r) => s + r.revenue, 0),
                ),
              },
            }
          : null,
    };
  }

  const [dailyRevenue, paymentPie] = await runPool(
    [
      () => salesRevenueTrend(db, tenantId, window),
      () => paymentStatusBreakdown(db, tenantId, window.from, window.to),
    ],
    NEON_QUERY_CONCURRENCY,
  );

  return {
    kpis: [
      {
        label: 'Revenue',
        icon: 'wallet',
        metricKey: 'revenue',
        color: '#059669',
        value: revenue,
        currency,
        ...computeDelta(revenue, priorRevenue),
      },
      {
        label: 'Transactions',
        icon: 'receipt',
        metricKey: 'transactionCount',
        color: '#2563eb',
        value: transactionCount,
        ...computeDelta(transactionCount, priorCount),
      },
      {
        label: 'Avg Ticket',
        icon: 'calculator',
        metricKey: 'avgTicket',
        color: '#9333ea',
        value: Math.round(avgTicket),
        currency,
      },
      {
        label: 'Refunds',
        icon: 'rotate-ccw',
        metricKey: 'refundedCount',
        color: '#e11d48',
        value: refundedCount,
      },
    ],
    charts: [
      {
        id: 'daily-closeout',
        title: 'Daily Closeout',
        subtitle: 'Revenue per day',
        type: 'bar',
        series: [{ name: 'Revenue', dataKey: 'revenue', color: '#059669' }],
        data:
          dailyRevenue.length > 0
            ? asChartData(dailyRevenue)
            : asChartData([{ label: '—', revenue: 0 }]),
      },
      {
        id: 'payment-status',
        title: 'Payment Status',
        subtitle: 'Transaction count by payment status',
        type: 'pie',
        series: [{ name: 'Count', dataKey: 'value', color: '#3b82f6' }],
        data:
          paymentPie.length > 0
            ? asChartData(paymentPie)
            : asChartData([{ label: 'paid', value: 0 }]),
      },
    ],
    table: null,
  };
}
