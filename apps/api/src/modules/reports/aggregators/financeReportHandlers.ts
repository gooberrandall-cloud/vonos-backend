import type {
  ProfitLossBreakdownTab,
  ReportRunOptions,
  ReportsDashboard,
  ReportsTable,
} from '@vonos/types';
import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { buildLedgerSummaryFromGroups, ledgerDateFilter } from '../../../common/utils/ledgerAggregates';
import { runPool } from '../../../common/utils/mapPool';
import { computeOutstandingReceivables } from '../../../common/utils/outstandingReceivables';
import { computeSalesRevenueTotal } from '../../../common/utils/salesRevenue';
import { toNumber } from '../../../common/utils/serializers';
import { computeDelta, resolveDateWindow } from './date-utils';
import { computeJobRevenueTotal } from './jobSalesData';
import {
  ledgerCurrency,
  ledgerPlTrend,
  ledgerSummaryInWindow,
} from './ledgerReportQueries';
import {
  buildHqProfitLossBreakdownTab,
  buildHqProfitLossFromContext,
  buildHqProfitLossSummaryOnly,
  buildProfitLossSummaryFromContext,
  loadProfitLossContext,
  type ProfitLossLoadContext,
} from './profitLossQueries';

const NEON_QUERY_CONCURRENCY = 2;

function priorWindow(window: { from: Date; to: Date }) {
  const spanMs = window.to.getTime() - window.from.getTime();
  return {
    from: new Date(window.from.getTime() - spanMs),
    to: new Date(window.from.getTime()),
  };
}

async function assembleProfitLossShell(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  loaded?: ProfitLossLoadContext,
): Promise<Omit<ReportsDashboard, 'profitLoss'>> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);

  const groups =
    loaded?.ledgerGroups ??
    (await db.ledgerEntry.groupBy({
      by: ['type', 'category'],
      where: {
        deletedAt: null,
        date: { gte: window.from, lte: window.to },
      },
      _sum: { amount: true },
    }));

  const currency =
    loaded?.salesRevenue.currency ??
    (await ledgerCurrency(db, tenantId));

  const [outstanding, priorLedger, trendRows] = await runPool(
    [
      () => computeOutstandingReceivables(db, from, to),
      () => ledgerSummaryInWindow(db, tenantId, prior.from, prior.to),
      () => ledgerPlTrend(db, tenantId, window),
    ],
    NEON_QUERY_CONCURRENCY,
  );

  const summary = buildLedgerSummaryFromGroups(
    groups.map((g) => ({
      type: g.type as 'revenue' | 'cost' | 'expense',
      _sum: { amount: g._sum.amount },
    })),
    currency,
  );
  summary.outstanding = outstanding;
  summary.net = summary.revenue - summary.costs;

  let revenueByCategory = new Map<string, number>();
  for (const group of groups.filter((g) => g.type === 'revenue')) {
    revenueByCategory.set(
      group.category ?? 'Other',
      toNumber(group._sum.amount ?? 0),
    );
  }

  let trendData = trendRows.map((row) => ({
    label: row.label,
    revenue: Math.round(row.revenue),
    costs: Math.round(row.costs),
    net: Math.round(row.revenue - row.costs),
  }));

  if (summary.revenue === 0) {
    const salesRevenue =
      loaded?.salesRevenue ?? (await computeSalesRevenueTotal(db, from, to));
    const jobRevenue = loaded
      ? { revenue: loaded.jobTotals.revenue }
      : await computeJobRevenueTotal(db, tenantId, from, to);
    const combinedRevenue = salesRevenue.revenue + jobRevenue.revenue;
    if (combinedRevenue > 0) {
      summary.revenue = combinedRevenue;
      summary.currency = salesRevenue.currency;
      summary.net = combinedRevenue - summary.costs;
      revenueByCategory = new Map([
        ...(salesRevenue.revenue > 0
          ? [['Sales', salesRevenue.revenue] as const]
          : []),
        ...(jobRevenue.revenue > 0 ? [['Jobs', jobRevenue.revenue] as const] : []),
      ]);
    }
  }

  return {
    kpis: [
      {
        label: 'Revenue',
        icon: 'wallet',
        metricKey: 'revenue',
        color: '#059669',
        value: summary.revenue,
        currency: summary.currency,
        ...computeDelta(summary.revenue, priorLedger.revenue),
      },
      {
        label: 'Costs',
        icon: 'receipt',
        metricKey: 'costs',
        color: '#2563eb',
        value: summary.costs,
        currency: summary.currency,
        ...computeDelta(summary.costs, priorLedger.costs),
      },
      {
        label: 'Net',
        icon: 'trending-up',
        metricKey: 'net',
        color: '#9333ea',
        value: summary.net,
        currency: summary.currency,
        ...computeDelta(summary.net, priorLedger.net),
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
        category: g.category ?? 'Other',
        type: g.type,
        amount: toNumber(g._sum.amount ?? 0),
        currency: summary.currency,
      })),
    },
  };
}

/** KPIs + charts + ledger table only — fast first paint. */
export async function buildProfitLossShell(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  return assembleProfitLossShell(db, tenantId, from, to);
}

/** Shell + HQ P&L summary in one context load — preferred initial request. */
export async function buildProfitLossCore(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  loaded?: ProfitLossLoadContext,
): Promise<ReportsDashboard> {
  const context =
    loaded ?? (await loadProfitLossContext(db, tenantId, from, to));
  const shell = await assembleProfitLossShell(
    db,
    tenantId,
    from,
    to,
    context,
  );
  return {
    ...shell,
    profitLoss: {
      summary: buildProfitLossSummaryFromContext(context),
      breakdowns: {},
    },
  };
}

/** HQ6 debit/credit summary block — loaded after shell. */
export async function buildProfitLossSummarySection(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  loaded?: ProfitLossLoadContext,
): Promise<ReportsDashboard> {
  const summary = await buildHqProfitLossSummaryOnly(
    db,
    tenantId,
    from,
    to,
    loaded,
  );
  return {
    kpis: [],
    charts: [],
    profitLoss: { summary, breakdowns: {} },
  };
}

/** Single breakdown tab — loaded on demand when user picks a tab. */
export async function buildProfitLossBreakdownSection(
  db: TenantScopedPrisma,
  tenantId: string,
  tab: ProfitLossBreakdownTab,
  from?: string,
  to?: string,
  loaded?: ProfitLossLoadContext,
): Promise<{ breakdown: ReportsTable; tab: ProfitLossBreakdownTab }> {
  const breakdown = await buildHqProfitLossBreakdownTab(
    db,
    tenantId,
    from,
    to,
    tab,
    loaded,
  );
  return { breakdown, tab };
}

/** Full report (shell + summary + all breakdowns) — export / legacy. */
export async function buildProfitLossReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const loaded = await loadProfitLossContext(db, tenantId, from, to, {
    includeBreakdown: true,
  });
  const shell = await assembleProfitLossShell(
    db,
    tenantId,
    from,
    to,
    loaded,
  );
  return { ...shell, profitLoss: buildHqProfitLossFromContext(loaded) };
}

export async function buildExpenseReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
): Promise<ReportsDashboard> {
  const dateFilter = ledgerDateFilter(from, to);
  const pageSize = Math.min(Math.max(options?.limit ?? 25, 1), 100);
  const search = options?.search?.trim();
  const expenseDateFilter =
    from || to
      ? {
          expenseDate: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        }
      : {};

  const expenseWhere: Prisma.ExpenseWhereInput = {
    deletedAt: null,
    ...expenseDateFilter,
    ...(options?.locationCode
      ? { locationCode: options.locationCode }
      : {}),
    ...(search
      ? {
          OR: [
            { refNo: { contains: search, mode: 'insensitive' } },
            { note: { contains: search, mode: 'insensitive' } },
            { expenseFor: { contains: search, mode: 'insensitive' } },
            { contactName: { contains: search, mode: 'insensitive' } },
            { category: { name: { contains: search, mode: 'insensitive' } } },
            {
              invoice: {
                reference: { contains: search, mode: 'insensitive' },
              },
            },
          ],
        }
      : {}),
  };

  const ledgerWhere: Prisma.LedgerEntryWhereInput = {
    deletedAt: null,
    type: 'expense',
    ...dateFilter,
  };

  const [expenseGroups, currencyRow, entryCount, expenseRowsRaw] =
    await runPool(
      [
        () =>
          db.ledgerEntry.groupBy({
            by: ['category'],
            where: ledgerWhere,
            _sum: { amount: true },
            orderBy: { category: 'asc' },
          }),
        () =>
          db.ledgerEntry.findFirst({
            where: ledgerWhere,
            select: { currency: true },
            orderBy: { date: 'desc' },
          }),
        () =>
          db.expense.count({
            where: expenseWhere,
          }),
        () =>
          db.expense.findMany({
            where: expenseWhere,
            select: {
              id: true,
              refNo: true,
              expenseDate: true,
              totalAmount: true,
              paymentStatus: true,
              note: true,
              locationCode: true,
              expenseFor: true,
              contactName: true,
              category: { select: { name: true } },
              invoice: { select: { reference: true } },
            },
            orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }],
            take: pageSize + 1,
            ...(options?.cursor
              ? { cursor: { id: options.cursor }, skip: 1 }
              : {}),
          }),
      ],
      NEON_QUERY_CONCURRENCY,
    );

  const hasMore = expenseRowsRaw.length > pageSize;
  const expenseRows = hasMore
    ? expenseRowsRaw.slice(0, pageSize)
    : expenseRowsRaw;
  const lastRow = expenseRows[expenseRows.length - 1];
  const nextCursor = hasMore && lastRow ? lastRow.id : null;

  const currency = currencyRow?.currency ?? 'NGN';
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
        value: entryCount,
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
        { key: 'reference', header: 'Ref / Invoice' },
        { key: 'category', header: 'Category' },
        { key: 'party', header: 'Expense For / Contact' },
        { key: 'location', header: 'Location' },
        { key: 'payment', header: 'Payment' },
        { key: 'note', header: 'Note' },
        { key: 'amount', header: 'Amount', totalAs: 'currency' },
      ],
      rows: expenseRows.map((row) => ({
        id: row.id,
        recordType: 'expense',
        date: row.expenseDate.toISOString().slice(0, 16).replace('T', ' '),
        reference: row.invoice?.reference ?? row.refNo ?? '—',
        category: row.category?.name ?? 'Uncategorized',
        party: [row.expenseFor, row.contactName].filter(Boolean).join(' · ') || '—',
        location: row.locationCode ?? '—',
        payment: row.paymentStatus ?? '—',
        note: row.note ?? '—',
        amount: toNumber(row.totalAmount),
        currency,
      })),
      hasMore,
      nextCursor,
      pageSize,
      columnTotals: {
        amount: Math.round(
          expenseRows.reduce((sum, row) => sum + toNumber(row.totalAmount), 0),
        ),
      },
    },
  };
}
