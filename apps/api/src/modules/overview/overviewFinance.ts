import type { Prisma } from '@prisma/client';
import type { ReportsChart, ReportsKpi } from '@vonos/types';
import type { TenantScopedPrisma } from '../../common/prisma/prisma.service';
import { toNumber } from '../../common/utils/serializers';
import {
  bucketKey,
  bucketLabel,
  computeDelta,
  priorWindow,
  resolveDateWindow,
} from '../reports/aggregators/date-utils';

interface LedgerRow {
  type: string;
  amount: Prisma.Decimal;
  currency: string;
  date: Date;
  category: string;
}

function summarizeLedger(entries: LedgerRow[]) {
  let revenue = 0;
  let costs = 0;

  for (const entry of entries) {
    const amount = toNumber(entry.amount);
    if (entry.type === 'revenue') revenue += amount;
    else costs += amount;
  }

  return { revenue, costs, net: revenue - costs };
}

function buildPlTrendData(
  entries: LedgerRow[],
  window: ReturnType<typeof resolveDateWindow>,
) {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const buckets = new Map<
    string,
    { label: string; revenue: number; costs: number }
  >();

  for (const entry of entries) {
    const key = bucketKey(entry.date, spanDays);
    const label = bucketLabel(entry.date, spanDays);
    const row = buckets.get(key) ?? { label, revenue: 0, costs: 0 };
    const amount = toNumber(entry.amount);
    if (entry.type === 'revenue') row.revenue += amount;
    else row.costs += amount;
    buckets.set(key, row);
  }

  const data = Array.from(buckets.values()).sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  return data.length > 0 ? data : [{ label: '—', revenue: 0, costs: 0 }];
}

function buildExpenseBreakdown(entries: LedgerRow[]) {
  const byCategory = new Map<string, number>();

  for (const entry of entries) {
    if (entry.type === 'revenue') continue;
    byCategory.set(
      entry.category,
      (byCategory.get(entry.category) ?? 0) + toNumber(entry.amount),
    );
  }

  const data = Array.from(byCategory.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([label, value]) => ({ label, value }));

  return data.length > 0 ? data : [{ label: '—', value: 0 }];
}

export interface LedgerFinanceSlice {
  currency: string;
  financeCharts: ReportsChart[];
  financeKpis: ReportsKpi[];
}

export async function buildLedgerFinanceSlice(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<LedgerFinanceSlice> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);

  const allEntries = await db.ledgerEntry.findMany({
    where: {
      deletedAt: null,
      date: { gte: prior.from, lte: window.to },
    },
    select: {
      type: true,
      amount: true,
      currency: true,
      date: true,
      category: true,
    },
  });

  const entries = allEntries.filter(
    (entry) => entry.date >= window.from && entry.date <= window.to,
  );
  const priorEntries = allEntries.filter(
    (entry) => entry.date >= prior.from && entry.date <= prior.to,
  );

  const summary = summarizeLedger(entries);
  const priorSummary = summarizeLedger(priorEntries);
  const currency = entries[0]?.currency ?? priorEntries[0]?.currency ?? 'NGN';

  const financeCharts: ReportsChart[] = [
    {
      id: 'finance-pl-trend',
      title: 'Revenue vs Costs',
      subtitle: 'Ledger totals for selected period',
      type: 'line',
      series: [
        { name: 'Revenue', dataKey: 'revenue', color: '#059669' },
        { name: 'Costs', dataKey: 'costs', color: '#e11d48' },
      ],
      data: buildPlTrendData(entries, window),
    },
    {
      id: 'finance-expense-breakdown',
      title: 'Costs & Expenses by Category',
      subtitle: 'Non-revenue ledger entries',
      type: 'pie',
      series: [{ name: 'Amount', dataKey: 'value', color: '#9333ea' }],
      data: buildExpenseBreakdown(entries),
    },
  ];

  const financeKpis: ReportsKpi[] = [
    {
      label: 'Revenue',
      icon: 'wallet',
      metricKey: 'revenue',
      color: '#059669',
      value: summary.revenue,
      currency,
      ...computeDelta(summary.revenue, priorSummary.revenue),
    },
    {
      label: 'Costs & Expenses',
      icon: 'calculator',
      metricKey: 'costs',
      color: '#2563eb',
      value: summary.costs,
      currency,
      ...computeDelta(summary.costs, priorSummary.costs),
    },
    {
      label: 'Net',
      icon: 'wallet',
      metricKey: 'net',
      color: '#9333ea',
      value: summary.net,
      currency,
      ...computeDelta(summary.net, priorSummary.net),
    },
  ];

  return { currency, financeCharts, financeKpis };
}
