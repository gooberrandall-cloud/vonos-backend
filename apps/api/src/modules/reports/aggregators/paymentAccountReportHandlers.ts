import type {
  BalanceSheetReport,
  CashFlowReport,
  ReportsDashboard,
} from '@vonos/types';
import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import {
  computeAllTimeOutstandingReceivables,
} from '../../../common/utils/outstandingReceivables';
import { runPool } from '../../../common/utils/mapPool';
import { toNumber } from '../../../common/utils/serializers';
import { resolveDateWindow } from './date-utils';

const NEON_QUERY_CONCURRENCY = 2;

type AccountBalance = {
  id: string;
  name: string;
  balance: number;
  currency: string;
};

type PeriodActivity = {
  debit: number;
  credit: number;
};

function formatReportDateTime(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}-${month}-${year} ${hours}:${minutes}`;
}

function txnDescription(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join('\n');
}

/** One grouped query for all account balances — avoids per-account N+1. */
async function accountBalances(
  db: TenantScopedPrisma,
  asOf?: Date,
): Promise<AccountBalance[]> {
  const accounts = await db.paymentAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  });

  if (accounts.length === 0) return [];

  const aggregates = await db.accountTransaction.groupBy({
    by: ['accountId', 'type'],
    where: {
      deletedAt: null,
      accountId: { in: accounts.map((a) => a.id) },
      ...(asOf ? { operationDate: { lte: asOf } } : {}),
    },
    _sum: { amount: true },
  });

  const byAccount = new Map<string, number>();
  for (const row of aggregates) {
    const amount = toNumber(row._sum.amount ?? 0);
    const delta = row.type === 'credit' ? amount : -amount;
    byAccount.set(row.accountId, (byAccount.get(row.accountId) ?? 0) + delta);
  }

  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    balance: byAccount.get(account.id) ?? 0,
    currency: account.currency,
  }));
}

/** Period debit/credit totals per account in one groupBy. */
async function accountPeriodActivity(
  db: TenantScopedPrisma,
  accountIds: string[],
  from: Date,
  to: Date,
): Promise<Map<string, PeriodActivity>> {
  const result = new Map<string, PeriodActivity>();
  if (accountIds.length === 0) return result;

  const aggregates = await db.accountTransaction.groupBy({
    by: ['accountId', 'type'],
    where: {
      deletedAt: null,
      accountId: { in: accountIds },
      operationDate: { gte: from, lte: to },
    },
    _sum: { amount: true },
  });

  for (const row of aggregates) {
    const current = result.get(row.accountId) ?? { debit: 0, credit: 0 };
    const amount = toNumber(row._sum.amount ?? 0);
    if (row.type === 'debit') current.debit += amount;
    else current.credit += amount;
    result.set(row.accountId, current);
  }

  return result;
}

async function computeSupplierDue(db: TenantScopedPrisma): Promise<number> {
  const rows = await db.$queryRaw<[{ supplier_due: Prisma.Decimal | null }]>`
    SELECT COALESCE(SUM("totalPurchaseDue"), 0) AS supplier_due
    FROM "Supplier"
    WHERE "deletedAt" IS NULL
  `;
  return Math.max(0, toNumber(rows[0]?.supplier_due ?? 0));
}

async function computeClosingStock(db: TenantScopedPrisma): Promise<number> {
  const rows = await db.$queryRaw<[{ stock_value: Prisma.Decimal | null }]>`
    SELECT COALESCE(SUM(quantity * "costPrice"), 0) AS stock_value
    FROM "Item"
    WHERE "deletedAt" IS NULL
  `;
  return Math.max(0, toNumber(rows[0]?.stock_value ?? 0));
}

async function openingBalancesBefore(
  db: TenantScopedPrisma,
  accountIds: string[],
  before: Date,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (accountIds.length === 0) return result;

  const rows = await db.$queryRaw<
    Array<{ accountId: string; balance: Prisma.Decimal | null }>
  >`
    SELECT
      "accountId",
      COALESCE(SUM(
        CASE WHEN type = 'credit' THEN amount ELSE -amount END
      ), 0) AS balance
    FROM "AccountTransaction"
    WHERE "deletedAt" IS NULL
      AND "accountId" IN (${Prisma.join(accountIds)})
      AND "operationDate" < ${before}
    GROUP BY "accountId"
  `;

  for (const row of rows) {
    result.set(row.accountId, toNumber(row.balance ?? 0));
  }
  return result;
}

/** Balance sheet — liabilities vs assets snapshot. */
export async function buildBalanceSheetReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const [accounts, customerDue, supplierDue, closingStock] = await runPool(
    [
      () => accountBalances(db, window.to),
      () => computeAllTimeOutstandingReceivables(db),
      () => computeSupplierDue(db),
      () => computeClosingStock(db),
    ],
    NEON_QUERY_CONCURRENCY,
  );

  const currency = accounts[0]?.currency ?? 'NGN';
  const accountBalanceTotal = accounts.reduce(
    (sum, account) => sum + account.balance,
    0,
  );
  const totalAssets = customerDue + closingStock + accountBalanceTotal;
  const totalLiability = supplierDue;

  const balanceSheet: BalanceSheetReport = {
    currency,
    liabilities: [
      { key: 'supplier-due', label: 'Supplier Due', amount: supplierDue },
    ],
    assets: [
      { key: 'customer-due', label: 'Customer Due', amount: customerDue },
      { key: 'closing-stock', label: 'Closing stock', amount: closingStock },
    ],
    accountBalances: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      balance: account.balance,
    })),
    totalLiability,
    totalAssets,
  };

  return {
    kpis: [
      {
        label: 'Total Assets',
        icon: 'wallet',
        metricKey: 'assets',
        color: '#059669',
        value: Math.round(totalAssets),
        currency,
      },
      {
        label: 'Total Liability',
        icon: 'receipt',
        metricKey: 'liability',
        color: '#e11d48',
        value: Math.round(totalLiability),
        currency,
      },
      {
        label: 'Customer Due',
        icon: 'clock',
        metricKey: 'receivables',
        color: '#9333ea',
        value: Math.round(customerDue),
        currency,
      },
      {
        label: 'Closing Stock',
        icon: 'package',
        metricKey: 'stock',
        color: '#2563eb',
        value: Math.round(closingStock),
        currency,
      },
    ],
    charts: [],
    table: null,
    balanceSheet,
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

  const activity = await accountPeriodActivity(
    db,
    accounts.map((a) => a.id),
    window.from,
    window.to,
  );

  const rows: Array<Record<string, string | number>> = [];
  let totalDebit = 0;
  let totalCredit = 0;
  const currency = accounts[0]?.currency ?? 'NGN';

  for (const account of accounts) {
    const period = activity.get(account.id) ?? { debit: 0, credit: 0 };
    totalDebit += period.debit;
    totalCredit += period.credit;

    if (period.debit > 0 || period.credit > 0) {
      rows.push({
        account: account.name,
        debit: Math.round(period.debit),
        credit: Math.round(period.credit),
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
        { key: 'debit', header: 'Debit', totalAs: 'currency' },
        { key: 'credit', header: 'Credit', totalAs: 'currency' },
      ],
      rows,
      columnTotals: {
        debit: Math.round(totalDebit),
        credit: Math.round(totalCredit),
      },
    },
  };
}

/** Payment account report — transaction-level ledger for the period. */
export async function buildPaymentAccountReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
  options?: { accountId?: string },
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);

  const transactions = await db.accountTransaction.findMany({
    where: {
      deletedAt: null,
      operationDate: { gte: window.from, lte: window.to },
      ...(options?.accountId ? { accountId: options.accountId } : {}),
    },
    include: {
      account: { select: { name: true } },
      invoice: { select: { reference: true } },
    },
    orderBy: [{ operationDate: 'desc' }, { id: 'desc' }],
    take: 500,
  });

  const saleIds = transactions
    .map((row) => row.saleId)
    .filter((id): id is string => Boolean(id));
  const sales =
    saleIds.length > 0
      ? await db.sale.findMany({
          where: { id: { in: saleIds }, deletedAt: null },
          select: {
            id: true,
            reference: true,
            customer: { select: { name: true } },
          },
        })
      : [];
  const saleRefById = new Map(sales.map((sale) => [sale.id, sale.reference]));
  const saleCustomerById = new Map(
    sales.map((sale) => [sale.id, sale.customer?.name ?? null]),
  );

  const currency = 'NGN';
  let totalAmount = 0;

  const rows = transactions.map((row) => {
    const amount = toNumber(row.amount);
    totalAmount += amount;
    const invoiceRef =
      row.invoice?.reference ??
      (row.saleId ? (saleRefById.get(row.saleId) ?? '—') : '—');
    const customerName = row.saleId
      ? saleCustomerById.get(row.saleId)
      : null;

    return {
      id: row.id,
      date: formatReportDateTime(row.operationDate),
      paymentRef: row.refNo ?? '—',
      invoiceRef,
      amount: Math.round(amount),
      paymentType: row.subType ?? (row.type === 'credit' ? 'Credit' : 'Debit'),
      account: row.account.name,
      createdBy: row.createdByName ?? '—',
      description: txnDescription([
        customerName ? `Customer: ${customerName}` : null,
        row.note,
        row.paymentDetails ? `Details: ${row.paymentDetails}` : null,
      ]),
      currency,
    };
  });

  return {
    kpis: [
      {
        label: 'Transactions',
        icon: 'receipt',
        metricKey: 'transactions',
        color: '#2563eb',
        value: rows.length,
      },
      {
        label: 'Total Amount',
        icon: 'wallet',
        metricKey: 'totalAmount',
        color: '#059669',
        value: Math.round(totalAmount),
        currency,
      },
    ],
    charts: [],
    table: {
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'paymentRef', header: 'Payment Ref No.' },
        { key: 'invoiceRef', header: 'Invoice No./Ref. No.' },
        { key: 'amount', header: 'Amount', totalAs: 'currency' },
        { key: 'paymentType', header: 'Payment Type' },
        { key: 'account', header: 'Account' },
        { key: 'createdBy', header: 'Added By' },
        { key: 'description', header: 'Description' },
      ],
      rows,
      columnTotals: { amount: Math.round(totalAmount) },
    },
  };
}

export async function buildCashFlowReport(
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
  const accountIds = accounts.map((account) => account.id);
  const accountNameById = new Map(
    accounts.map((account) => [account.id, account.name]),
  );
  const currency = accounts[0]?.currency ?? 'NGN';

  const [openingByAccount, transactions] = await Promise.all([
    openingBalancesBefore(db, accountIds, window.from),
    db.accountTransaction.findMany({
      where: {
        deletedAt: null,
        operationDate: { gte: window.from, lte: window.to },
      },
      select: {
        id: true,
        accountId: true,
        type: true,
        amount: true,
        operationDate: true,
        note: true,
        subType: true,
        paymentMethod: true,
        paymentDetails: true,
        refNo: true,
      },
      orderBy: [{ operationDate: 'asc' }, { id: 'asc' }],
      take: 500,
    }),
  ]);

  const runningByAccount = new Map<string, number>();
  for (const accountId of accountIds) {
    runningByAccount.set(accountId, openingByAccount.get(accountId) ?? 0);
  }

  let totalDebit = 0;
  let totalCredit = 0;

  const rows = transactions.map((row) => {
    const amount = toNumber(row.amount);
    const previousBalance = runningByAccount.get(row.accountId) ?? 0;
    const delta = row.type === 'credit' ? amount : -amount;
    const totalBalance = previousBalance + delta;
    runningByAccount.set(row.accountId, totalBalance);

    if (row.type === 'debit') totalDebit += amount;
    else totalCredit += amount;

    return {
      id: row.id,
      date: formatReportDateTime(row.operationDate),
      account: accountNameById.get(row.accountId) ?? '—',
      description: txnDescription([
        row.subType,
        row.note,
        row.paymentDetails,
      ]),
      paymentMethod: row.paymentMethod ?? '—',
      receiptVoucher: row.refNo ?? '—',
      debit: row.type === 'debit' ? Math.round(amount) : null,
      credit: row.type === 'credit' ? Math.round(amount) : null,
      previousBalance: Math.round(previousBalance),
      totalBalance: Math.round(totalBalance),
    };
  });

  const cashFlow: CashFlowReport = {
    currency,
    rows,
    totals: {
      debit: Math.round(totalDebit),
      credit: Math.round(totalCredit),
      balance: Math.round(totalCredit - totalDebit),
    },
  };

  return {
    kpis: [
      {
        label: 'Cash In',
        icon: 'arrow-down',
        metricKey: 'cashIn',
        color: '#059669',
        value: Math.round(totalCredit),
        currency,
      },
      {
        label: 'Cash Out',
        icon: 'arrow-up',
        metricKey: 'cashOut',
        color: '#e11d48',
        value: Math.round(totalDebit),
        currency,
      },
      {
        label: 'Net Cash',
        icon: 'wallet',
        metricKey: 'netCash',
        color: '#9333ea',
        value: Math.round(totalCredit - totalDebit),
        currency,
      },
    ],
    charts: [],
    table: null,
    cashFlow,
  };
}
