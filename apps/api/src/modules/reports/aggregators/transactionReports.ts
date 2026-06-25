import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { buildTimeSeries, computeDelta } from './date-utils';
import { aggregateTopProducts } from './productSales';
import { loadSalesReportContext, type SalesReportContext } from './salesData';

type TransactionTab = 'sales' | 'closeout';

function buildTransactionReportsFromContext(
  ctx: SalesReportContext,
  tab: TransactionTab,
): ReportsDashboard {
  const { window, periodSales, priorSales, currency } = ctx;

  const revenue = periodSales.reduce((sum, s) => sum + s.total, 0);
  const priorRevenue = priorSales.reduce((sum, s) => sum + s.total, 0);
  const transactionCount = periodSales.length;
  const priorCount = priorSales.length;
  const avgTicket = transactionCount > 0 ? revenue / transactionCount : 0;
  const priorAvg = priorCount > 0 ? priorRevenue / priorCount : 0;
  const refundedCount = periodSales.filter(
    (s) => s.status === 'refunded' || s.status === 'partially_refunded',
  ).length;

  const trendData = buildTimeSeries(
    periodSales.map((s) => ({ date: s.date, total: s.total })),
    window,
    (row) => row.total,
  ).map((row) => ({ label: row.label, revenue: Math.round(row.value) }));

  const topProducts = aggregateTopProducts(periodSales, 12);
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
          data: trendData.length > 0 ? trendData : [{ label: '—', revenue: 0 }],
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
            }
          : null,
    };
  }

  // closeout — daily revenue bars + payment status pie
  const dailyRevenue = buildTimeSeries(
    periodSales.map((s) => ({ date: s.date, total: s.total })),
    window,
    (row) => row.total,
  ).map((row) => ({ label: row.label, revenue: Math.round(row.value) }));

  const paymentCounts = new Map<string, number>();
  for (const sale of periodSales) {
    const key = sale.paymentStatus ?? 'unknown';
    paymentCounts.set(key, (paymentCounts.get(key) ?? 0) + 1);
  }
  const paymentPie = Array.from(paymentCounts.entries()).map(
    ([label, value]) => ({
      label,
      value,
    }),
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
          dailyRevenue.length > 0 ? dailyRevenue : [{ label: '—', revenue: 0 }],
      },
      {
        id: 'payment-status',
        title: 'Payment Status',
        subtitle: 'Transaction count by payment status',
        type: 'pie',
        series: [{ name: 'Count', dataKey: 'value', color: '#3b82f6' }],
        data:
          paymentPie.length > 0 ? paymentPie : [{ label: 'paid', value: 0 }],
      },
    ],
    table: null,
  };
}

export async function buildTransactionReports(
  db: TenantScopedPrisma,
  tab: TransactionTab,
  from?: string,
  to?: string,
  ctx?: SalesReportContext,
): Promise<ReportsDashboard> {
  const salesCtx = ctx ?? (await loadSalesReportContext(db, from, to));
  return buildTransactionReportsFromContext(salesCtx, tab);
}
