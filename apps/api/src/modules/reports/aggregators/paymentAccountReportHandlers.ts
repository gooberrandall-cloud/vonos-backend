import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { computeOutstandingReceivables } from '../../../common/utils/outstandingReceivables';
import { toNumber } from '../../../common/utils/serializers';
import { ledgerDateFilter } from '../../../common/utils/ledgerAggregates';
import { resolveDateWindow } from './date-utils';

async function accountBalances(
  db: TenantScopedPrisma,
): Promise<
  Array<{ id: string; name: string; balance: number; currency: string }>
> {
  const accounts = await db.paymentAccount.findMany({
    where: { deletedAt: null, isClosed: false },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  });

  const balances = await Promise.all(
    accounts.map(async (account) => {
      const txns = await db.accountTransaction.findMany({
        where: { accountId: account.id, deletedAt: null },
        select: { type: true, amount: true },
      });
      const balance = txns.reduce((sum, row) => {
        const amount = toNumber(row.amount);
        return row.type === 'credit' ? sum + amount : sum - amount;
      }, 0);
      return {
        id: account.id,
        name: account.name,
        balance,
        currency: account.currency,
      };
    }),
  );

  return balances;
}

/** Balance sheet — cash accounts + receivables vs ledger costs/expenses. */
export async function buildBalanceSheetReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const dateFilter = ledgerDateFilter(from, to);
  const [accounts, outstanding, ledgerGroups] = await Promise.all([
    accountBalances(db),
    computeOutstandingReceivables(db, from, to),
    db.ledgerEntry.groupBy({
      by: ['type'],
      where: { deletedAt: null, ...dateFilter },
      _sum: { amount: true },
    }),
  ]);

  const currency = accounts[0]?.currency ?? 'NGN';
  const cashAssets = accounts.reduce(
    (sum, a) => sum + Math.max(0, a.balance),
    0,
  );
  const receivables = outstanding;
  const totalAssets = cashAssets + receivables;

  const costs = ledgerGroups
    .filter((g) => g.type === 'cost')
    .reduce((sum, g) => sum + toNumber(g._sum.amount ?? 0), 0);
  const expenses = ledgerGroups
    .filter((g) => g.type === 'expense')
    .reduce((sum, g) => sum + toNumber(g._sum.amount ?? 0), 0);
  const revenue = ledgerGroups
    .filter((g) => g.type === 'revenue')
    .reduce((sum, g) => sum + toNumber(g._sum.amount ?? 0), 0);
  const equity = revenue - costs - expenses;

  return {
    kpis: [
      {
        label: 'Total Assets',
        icon: 'wallet',
        metricKey: 'assets',
        color: '#059669',
        value: totalAssets,
        currency,
      },
      {
        label: 'Cash & Accounts',
        icon: 'banknote',
        metricKey: 'cash',
        color: '#2563eb',
        value: cashAssets,
        currency,
      },
      {
        label: 'Receivables',
        icon: 'clock',
        metricKey: 'receivables',
        color: '#9333ea',
        value: receivables,
        currency,
      },
      {
        label: 'Equity (P&L)',
        icon: 'trending-up',
        metricKey: 'equity',
        color: '#e11d48',
        value: equity,
        currency,
      },
    ],
    charts: [
      {
        id: 'asset-mix',
        title: 'Asset Mix',
        type: 'pie',
        series: [{ name: 'Amount', dataKey: 'value', color: '#059669' }],
        data: [
          { label: 'Cash accounts', value: Math.round(cashAssets) },
          { label: 'Receivables', value: Math.round(receivables) },
        ].filter((row) => row.value > 0),
      },
    ],
    table: {
      columns: [
        { key: 'section', header: 'Section' },
        { key: 'name', header: 'Account' },
        { key: 'amount', header: 'Amount' },
      ],
      rows: [
        ...accounts.map((a) => ({
          section: 'Asset',
          name: a.name,
          amount: Math.round(a.balance),
          currency: a.currency,
        })),
        {
          section: 'Asset',
          name: 'Outstanding receivables',
          amount: Math.round(receivables),
          currency,
        },
        {
          section: 'Equity',
          name: 'Retained (revenue − costs − expenses)',
          amount: Math.round(equity),
          currency,
        },
      ],
    },
  };
}

/** Trial balance — debits and credits per payment account in period. */
export async function buildTrialBalanceReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const accounts = await db.paymentAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  });

  const rows: Array<Record<string, string | number>> = [];
  let totalDebit = 0;
  let totalCredit = 0;
  const currency = accounts[0]?.currency ?? 'NGN';

  for (const account of accounts) {
    const txns = await db.accountTransaction.findMany({
      where: {
        accountId: account.id,
        deletedAt: null,
        operationDate: { gte: window.from, lte: window.to },
      },
      select: { type: true, amount: true },
    });

    const debit = txns
      .filter((t) => t.type === 'debit')
      .reduce((sum, t) => sum + toNumber(t.amount), 0);
    const credit = txns
      .filter((t) => t.type === 'credit')
      .reduce((sum, t) => sum + toNumber(t.amount), 0);

    totalDebit += debit;
    totalCredit += credit;

    if (debit > 0 || credit > 0) {
      rows.push({
        account: account.name,
        debit: Math.round(debit),
        credit: Math.round(credit),
        currency: account.currency,
      });
    }
  }

  return {
    kpis: [
      {
        label: 'Total Debits',
        icon: 'arrow-up',
        metricKey: 'debits',
        color: '#e11d48',
        value: Math.round(totalDebit),
        currency,
      },
      {
        label: 'Total Credits',
        icon: 'arrow-down',
        metricKey: 'credits',
        color: '#059669',
        value: Math.round(totalCredit),
        currency,
      },
      {
        label: 'Accounts',
        icon: 'credit-card',
        metricKey: 'accounts',
        color: '#2563eb',
        value: rows.length,
      },
    ],
    charts: [],
    table: {
      columns: [
        { key: 'account', header: 'Account' },
        { key: 'debit', header: 'Debit' },
        { key: 'credit', header: 'Credit' },
      ],
      rows,
    },
  };
}

/** Payment account summary — balance per account with period activity. */
export async function buildPaymentAccountReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const accounts = await accountBalances(db);
  const currency = accounts[0]?.currency ?? 'NGN';

  const rows: Array<Record<string, string | number>> = [];
  let totalIn = 0;
  let totalOut = 0;

  for (const account of accounts) {
    const txns = await db.accountTransaction.findMany({
      where: {
        accountId: account.id,
        deletedAt: null,
        operationDate: { gte: window.from, lte: window.to },
      },
      select: { type: true, amount: true },
    });

    const credits = txns
      .filter((t) => t.type === 'credit')
      .reduce((sum, t) => sum + toNumber(t.amount), 0);
    const debits = txns
      .filter((t) => t.type === 'debit')
      .reduce((sum, t) => sum + toNumber(t.amount), 0);

    totalIn += credits;
    totalOut += debits;

    rows.push({
      account: account.name,
      moneyIn: Math.round(credits),
      moneyOut: Math.round(debits),
      balance: Math.round(account.balance),
      currency: account.currency,
    });
  }

  return {
    kpis: [
      {
        label: 'Money In',
        icon: 'arrow-down',
        metricKey: 'moneyIn',
        color: '#059669',
        value: Math.round(totalIn),
        currency,
      },
      {
        label: 'Money Out',
        icon: 'arrow-up',
        metricKey: 'moneyOut',
        color: '#e11d48',
        value: Math.round(totalOut),
        currency,
      },
      {
        label: 'Accounts',
        icon: 'credit-card',
        metricKey: 'accounts',
        color: '#2563eb',
        value: accounts.length,
      },
    ],
    charts: [
      {
        id: 'account-balances',
        title: 'Account Balances',
        type: 'bar',
        horizontal: true,
        series: [{ name: 'Balance', dataKey: 'balance', color: '#2563eb' }],
        data: accounts.slice(0, 12).map((a) => ({
          label: a.name,
          balance: Math.round(a.balance),
        })),
      },
    ],
    table: {
      columns: [
        { key: 'account', header: 'Account' },
        { key: 'moneyIn', header: 'Money In' },
        { key: 'moneyOut', header: 'Money Out' },
        { key: 'balance', header: 'Balance' },
      ],
      rows,
    },
  };
}

export async function buildCashFlowReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);

  const [sellPayments, purchaseDebits, revenueAgg] = await Promise.all([
    db.payment.aggregate({
      where: {
        deletedAt: null,
        saleId: { not: null },
        OR: [
          { paidOn: { gte: window.from, lte: window.to } },
          { paidOn: null, createdAt: { gte: window.from, lte: window.to } },
        ],
      },
      _sum: { amount: true },
    }),
    db.accountTransaction.aggregate({
      where: {
        deletedAt: null,
        type: 'debit',
        operationDate: { gte: window.from, lte: window.to },
      },
      _sum: { amount: true },
    }),
    db.ledgerEntry.aggregate({
      where: {
        deletedAt: null,
        type: 'revenue',
        ...ledgerDateFilter(from, to),
      },
      _sum: { amount: true },
    }),
  ]);

  const currency = 'NGN';
  const cashIn = toNumber(sellPayments._sum.amount ?? 0);
  const cashOut = toNumber(purchaseDebits._sum.amount ?? 0);
  const salesRevenue = toNumber(revenueAgg._sum.amount ?? 0);
  const effectiveCashIn = cashIn > 0 ? cashIn : salesRevenue;

  return {
    kpis: [
      {
        label: 'Cash In',
        icon: 'arrow-down',
        metricKey: 'cashIn',
        color: '#059669',
        value: Math.round(effectiveCashIn),
        currency,
      },
      {
        label: 'Cash Out',
        icon: 'arrow-up',
        metricKey: 'cashOut',
        color: '#e11d48',
        value: Math.round(cashOut),
        currency,
      },
      {
        label: 'Net Cash',
        icon: 'wallet',
        metricKey: 'netCash',
        color: '#9333ea',
        value: Math.round(effectiveCashIn - cashOut),
        currency,
      },
    ],
    charts: [
      {
        id: 'cash-flow',
        title: 'Cash Movement',
        type: 'bar',
        series: [
          { name: 'In', dataKey: 'in', color: '#059669' },
          { name: 'Out', dataKey: 'out', color: '#e11d48' },
        ],
        data: [
          {
            label: 'Period',
            in: Math.round(effectiveCashIn),
            out: Math.round(cashOut),
          },
        ],
      },
    ],
    table: null,
  };
}
