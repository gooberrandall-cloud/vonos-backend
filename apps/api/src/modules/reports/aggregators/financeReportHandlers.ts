import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import {
  buildLedgerSummaryFromGroups,
  ledgerDateFilter,
} from '../../../common/utils/ledgerAggregates';
import { computeOutstandingReceivables } from '../../../common/utils/outstandingReceivables';
import { computeSalesRevenueTotal } from '../../../common/utils/salesRevenue';
import { toNumber } from '../../../common/utils/serializers';
import {
  bucketKey,
  bucketLabel,
  computeDelta,
  resolveDateWindow,
} from './date-utils';
import { loadSalesReportContext } from './salesData';

export async function buildProfitLossReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const dateFilter = ledgerDateFilter(from, to);
  const window = resolveDateWindow(from, to);

  const [groups, currencyRow, ledgerRows, outstanding, priorGroups] =
    await Promise.all([
      db.ledgerEntry.groupBy({
        by: ['type', 'category'],
        where: { deletedAt: null, ...dateFilter },
        _sum: { amount: true },
      }),
      db.ledgerEntry.findFirst({
        where: { deletedAt: null, ...dateFilter },
        select: { currency: true },
        orderBy: { date: 'desc' },
      }),
      db.ledgerEntry.findMany({
        where: { deletedAt: null, ...dateFilter },
        select: { type: true, amount: true, date: true, category: true },
      }),
      computeOutstandingReceivables(db, from, to),
      db.ledgerEntry.groupBy({
        by: ['type'],
        where: {
          deletedAt: null,
          date: {
            gte: new Date(
              window.from.getTime() -
                (window.to.getTime() - window.from.getTime()),
            ),
            lt: window.from,
          },
        },
        _sum: { amount: true },
      }),
    ]);

  const summary = buildLedgerSummaryFromGroups(
    groups.map((g) => ({
      type: g.type,
      _sum: { amount: g._sum.amount },
    })),
    currencyRow?.currency ?? 'NGN',
  );
  summary.outstanding = outstanding;
  summary.net = summary.revenue - summary.costs;

  const priorRevenue = priorGroups
    .filter((g) => g.type === 'revenue')
    .reduce((sum, g) => sum + toNumber(g._sum.amount ?? 0), 0);
  const priorCosts = priorGroups
    .filter((g) => g.type !== 'revenue')
    .reduce((sum, g) => sum + toNumber(g._sum.amount ?? 0), 0);

  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const trendBuckets = new Map<
    string,
    { label: string; revenue: number; costs: number }
  >();

  for (const row of ledgerRows) {
    const key = bucketKey(row.date, spanDays);
    const label = bucketLabel(row.date, spanDays);
    const bucket = trendBuckets.get(key) ?? { label, revenue: 0, costs: 0 };
    const amount = toNumber(row.amount);
    if (row.type === 'revenue') bucket.revenue += amount;
    else bucket.costs += amount;
    trendBuckets.set(key, bucket);
  }

  let revenueByCategory = new Map<string, number>();
  for (const group of groups.filter((g) => g.type === 'revenue')) {
    revenueByCategory.set(group.category, toNumber(group._sum.amount ?? 0));
  }

  // VISP fallback: revenue from sale totals when ledger rows were not backfilled
  if (summary.revenue === 0) {
    const salesRevenue = await computeSalesRevenueTotal(db, from, to);
    if (salesRevenue.revenue > 0) {
      summary.revenue = salesRevenue.revenue;
      summary.currency = salesRevenue.currency;
      summary.net = salesRevenue.revenue - summary.costs;
      revenueByCategory = new Map([['Sales', salesRevenue.revenue]]);

      const ctx = await loadSalesReportContext(db, from, to);
      for (const sale of ctx.periodSales) {
        const key = bucketKey(sale.date, spanDays);
        const label = bucketLabel(sale.date, spanDays);
        const bucket = trendBuckets.get(key) ?? { label, revenue: 0, costs: 0 };
        bucket.revenue += sale.total;
        trendBuckets.set(key, bucket);
      }
    }
  }

  const trendData = Array.from(trendBuckets.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((row) => ({
      label: row.label,
      revenue: Math.round(row.revenue),
      costs: Math.round(row.costs),
      net: Math.round(row.revenue - row.costs),
    }));

  return {
    kpis: [
      {
        label: 'Revenue',
        icon: 'wallet',
        metricKey: 'revenue',
        color: '#059669',
        value: summary.revenue,
        currency: summary.currency,
        ...computeDelta(summary.revenue, priorRevenue),
      },
      {
        label: 'Costs',
        icon: 'receipt',
        metricKey: 'costs',
        color: '#2563eb',
        value: summary.costs,
        currency: summary.currency,
        ...computeDelta(summary.costs, priorCosts),
      },
      {
        label: 'Net',
        icon: 'trending-up',
        metricKey: 'net',
        color: '#9333ea',
        value: summary.net,
        currency: summary.currency,
        ...computeDelta(summary.net, priorRevenue - priorCosts),
      },
      {
        label: 'Outstanding',
        icon: 'clock',
        metricKey: 'outstanding',
        color: '#e11d48',
        value: outstanding,
        currency: summary.currency,
      },
    ],
    charts: [
      {
        id: 'pl-trend',
        title: 'P&L Trend',
        subtitle: 'Revenue vs costs over selected period',
        type: 'line',
        series: [
          { name: 'Revenue', dataKey: 'revenue', color: '#059669' },
          { name: 'Costs', dataKey: 'costs', color: '#2563eb' },
        ],
        data:
          trendData.length > 0
            ? trendData
            : [{ label: '—', revenue: 0, costs: 0, net: 0 }],
      },
      {
        id: 'revenue-by-category',
        title: 'Revenue by Category',
        type: 'pie',
        series: [{ name: 'Revenue', dataKey: 'value', color: '#059669' }],
        data: Array.from(revenueByCategory.entries()).map(([label, value]) => ({
          label,
          value: Math.round(value),
        })),
      },
    ],
    table: {
      columns: [
        { key: 'category', header: 'Category' },
        { key: 'type', header: 'Type' },
        { key: 'amount', header: 'Amount' },
      ],
      rows: groups.map((g) => ({
        category: g.category,
        type: g.type,
        amount: toNumber(g._sum.amount ?? 0),
        currency: summary.currency,
      })),
    },
  };
}

export async function buildExpenseReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const dateFilter = ledgerDateFilter(from, to);

  const [expenseGroups, currencyRow, expenseRows] = await Promise.all([
    db.ledgerEntry.groupBy({
      by: ['category'],
      where: { deletedAt: null, type: 'expense', ...dateFilter },
      _sum: { amount: true },
      orderBy: { category: 'asc' },
    }),
    db.ledgerEntry.findFirst({
      where: { deletedAt: null, type: 'expense', ...dateFilter },
      select: { currency: true },
      orderBy: { date: 'desc' },
    }),
    db.ledgerEntry.findMany({
      where: { deletedAt: null, type: 'expense', ...dateFilter },
      select: {
        id: true,
        category: true,
        description: true,
        amount: true,
        currency: true,
        date: true,
      },
      orderBy: { date: 'desc' },
      take: 200,
    }),
  ]);

  const currency = currencyRow?.currency ?? expenseRows[0]?.currency ?? 'NGN';
  const totalExpenses = expenseGroups.reduce(
    (sum, g) => sum + toNumber(g._sum.amount ?? 0),
    0,
  );

  const chartData = expenseGroups.map((g) => ({
    label: g.category,
    value: Math.round(toNumber(g._sum.amount ?? 0)),
  }));

  return {
    kpis: [
      {
        label: 'Total Expenses',
        icon: 'receipt',
        metricKey: 'expenses',
        color: '#e11d48',
        value: totalExpenses,
        currency,
      },
      {
        label: 'Categories',
        icon: 'folder-tree',
        metricKey: 'categories',
        color: '#2563eb',
        value: expenseGroups.length,
      },
      {
        label: 'Entries',
        icon: 'file-text',
        metricKey: 'entries',
        color: '#9333ea',
        value: expenseRows.length,
      },
    ],
    charts: [
      {
        id: 'expense-by-category',
        title: 'Expenses by Category',
        type: 'bar',
        horizontal: true,
        series: [{ name: 'Amount', dataKey: 'value', color: '#e11d48' }],
        data: chartData.length > 0 ? chartData : [{ label: '—', value: 0 }],
      },
    ],
    table: {
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'category', header: 'Category' },
        { key: 'description', header: 'Description' },
        { key: 'amount', header: 'Amount' },
      ],
      rows: expenseRows.map((row) => ({
        id: row.id,
        recordType: 'ledgerEntry',
        date: row.date.toISOString().slice(0, 10),
        category: row.category,
        description: row.description,
        amount: toNumber(row.amount),
        currency: row.currency,
      })),
    },
  };
}
