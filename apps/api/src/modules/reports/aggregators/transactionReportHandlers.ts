import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { ledgerDateFilter } from '../../../common/utils/ledgerAggregates';
import { toNumber, toStringField } from '../../../common/utils/serializers';
import {
  bucketKey,
  bucketLabel,
  computeDelta,
  resolveDateWindow,
} from './date-utils';
import { aggregateTopProducts } from './productSales';
import { loadSalesReportContext } from './salesData';

function currencyKpi(
  label: string,
  metricKey: string,
  value: number,
  currency: string,
  color: string,
  icon: string,
  delta?: ReturnType<typeof computeDelta>,
) {
  return {
    label,
    icon,
    metricKey,
    color,
    value,
    currency,
    ...delta,
  };
}

function countKpi(
  label: string,
  metricKey: string,
  value: number,
  color: string,
  icon: string,
  delta?: ReturnType<typeof computeDelta>,
) {
  return { label, icon, metricKey, color, value, ...delta };
}

/** Purchase & Sale — sales revenue vs ledger cost (purchase proxy for retail). */
export async function buildPurchaseSaleReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const ctx = await loadSalesReportContext(db, from, to);
  const { window, periodSales, priorSales, currency } = ctx;

  const salesTotal = periodSales.reduce((sum, s) => sum + s.total, 0);
  const priorSalesTotal = priorSales.reduce((sum, s) => sum + s.total, 0);

  const [purchaseAgg, priorPurchaseAgg] = await Promise.all([
    db.ledgerEntry.aggregate({
      where: {
        deletedAt: null,
        type: 'cost',
        date: { gte: window.from, lte: window.to },
      },
      _sum: { amount: true },
    }),
    db.ledgerEntry.aggregate({
      where: {
        deletedAt: null,
        type: 'cost',
        date: { gte: ctx.prior.from, lte: ctx.prior.to },
      },
      _sum: { amount: true },
    }),
  ]);

  const purchases = toNumber(purchaseAgg._sum.amount ?? 0);
  const priorPurchases = toNumber(priorPurchaseAgg._sum.amount ?? 0);
  const grossProfit = salesTotal - purchases;

  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const monthBuckets = new Map<
    string,
    { label: string; sales: number; purchases: number }
  >();

  for (const sale of periodSales) {
    const key = bucketKey(sale.date, spanDays);
    const label = bucketLabel(sale.date, spanDays);
    const row = monthBuckets.get(key) ?? { label, sales: 0, purchases: 0 };
    row.sales += sale.total;
    monthBuckets.set(key, row);
  }

  const costRows = await db.ledgerEntry.findMany({
    where: {
      deletedAt: null,
      type: 'cost',
      date: { gte: window.from, lte: window.to },
    },
    select: { date: true, amount: true },
  });
  for (const row of costRows) {
    const key = bucketKey(row.date, spanDays);
    const label = bucketLabel(row.date, spanDays);
    const existing = monthBuckets.get(key) ?? { label, sales: 0, purchases: 0 };
    existing.purchases += toNumber(row.amount);
    monthBuckets.set(key, existing);
  }

  const chartData = Array.from(monthBuckets.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((row) => ({
      label: row.label,
      sales: Math.round(row.sales),
      purchases: Math.round(row.purchases),
    }));

  return {
    kpis: [
      currencyKpi(
        'Total Sales',
        'sales',
        salesTotal,
        currency,
        '#059669',
        'wallet',
        computeDelta(salesTotal, priorSalesTotal),
      ),
      currencyKpi(
        'Total Purchases',
        'purchases',
        purchases,
        currency,
        '#2563eb',
        'truck',
        computeDelta(purchases, priorPurchases),
      ),
      currencyKpi(
        'Gross Profit',
        'grossProfit',
        grossProfit,
        currency,
        '#9333ea',
        'trending-up',
      ),
      countKpi(
        'Transactions',
        'transactionCount',
        periodSales.length,
        '#e11d48',
        'receipt',
        computeDelta(periodSales.length, priorSales.length),
      ),
    ],
    charts: [
      {
        id: 'purchase-vs-sale',
        title: 'Sales vs Purchases',
        subtitle: 'Revenue compared to recorded purchase costs',
        type: 'bar',
        series: [
          { name: 'Sales', dataKey: 'sales', color: '#059669' },
          { name: 'Purchases', dataKey: 'purchases', color: '#2563eb' },
        ],
        data:
          chartData.length > 0
            ? chartData
            : [{ label: '—', sales: 0, purchases: 0 }],
      },
    ],
    table: {
      columns: [
        { key: 'period', header: 'Period' },
        { key: 'sales', header: 'Sales' },
        { key: 'purchases', header: 'Purchases' },
        { key: 'margin', header: 'Margin' },
      ],
      rows: chartData.map((row) => ({
        period: row.label,
        sales: row.sales,
        purchases: row.purchases,
        margin: row.sales - row.purchases,
        currency,
      })),
    },
  };
}

/** Tax — prices are tax-inclusive in migrated VISP/VSP data; surfaces discounts and payment status. */
export async function buildTaxReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const ctx = await loadSalesReportContext(db, from, to);
  const { periodSales, currency } = ctx;

  const saleIds = periodSales.map((s) => s.id);
  const [lines, saleRefs] = await Promise.all([
    saleIds.length > 0
      ? db.saleLine.findMany({
          where: { saleId: { in: saleIds } },
          select: {
            saleId: true,
            quantity: true,
            unitPrice: true,
            lineTotal: true,
            discountAmount: true,
          },
        })
      : Promise.resolve([]),
    saleIds.length > 0
      ? db.sale.findMany({
          where: { id: { in: saleIds } },
          select: {
            id: true,
            reference: true,
            date: true,
            total: true,
            paymentStatus: true,
          },
        })
      : Promise.resolve([]),
  ]);

  let grossBeforeDiscount = 0;
  let discounts = 0;
  for (const line of lines) {
    const qty = toNumber(line.quantity);
    const unit = toNumber(line.unitPrice);
    const lineTotal = toNumber(line.lineTotal);
    grossBeforeDiscount += unit * qty;
    discounts += toNumber(line.discountAmount ?? 0);
    if (lineTotal < unit * qty) {
      discounts += unit * qty - lineTotal;
    }
  }

  const netSales = periodSales.reduce((sum, s) => sum + s.total, 0);

  const statusCounts = new Map<string, number>();
  for (const sale of periodSales) {
    const key = sale.paymentStatus ?? 'unknown';
    statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
  }

  return {
    kpis: [
      currencyKpi(
        'Net Sales (tax incl.)',
        'netSales',
        netSales,
        currency,
        '#059669',
        'wallet',
      ),
      currencyKpi(
        'Discounts',
        'discounts',
        Math.round(discounts),
        currency,
        '#9333ea',
        'percent',
      ),
      currencyKpi(
        'Line Subtotal',
        'gross',
        Math.round(grossBeforeDiscount),
        currency,
        '#2563eb',
        'receipt',
      ),
      countKpi(
        'Transactions',
        'transactionCount',
        periodSales.length,
        '#e11d48',
        'file-text',
      ),
    ],
    charts: [
      {
        id: 'payment-status-mix',
        title: 'Sales by Payment Status',
        subtitle: 'Completed transactions in period',
        type: 'pie',
        series: [{ name: 'Count', dataKey: 'value', color: '#3b82f6' }],
        data:
          statusCounts.size > 0
            ? Array.from(statusCounts.entries()).map(([label, value]) => ({
                label,
                value,
              }))
            : [{ label: 'paid', value: 0 }],
      },
    ],
    table: {
      columns: [
        { key: 'reference', header: 'Invoice' },
        { key: 'date', header: 'Date' },
        { key: 'total', header: 'Total (incl.)' },
        { key: 'paymentStatus', header: 'Payment' },
      ],
      rows: saleRefs.slice(0, 200).map((sale) => ({
        id: sale.id,
        recordType: 'sale',
        reference: sale.reference,
        date: sale.date.toISOString().slice(0, 10),
        total: Math.round(toNumber(sale.total)),
        paymentStatus: sale.paymentStatus ?? '—',
        currency,
      })),
    },
  };
}

/** Register — daily till summary from sales. */
export async function buildRegisterReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const ctx = await loadSalesReportContext(db, from, to);
  const { periodSales, currency } = ctx;

  const byDay = new Map<
    string,
    { label: string; count: number; revenue: number }
  >();

  for (const sale of periodSales) {
    const label = sale.date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const key = sale.date.toISOString().slice(0, 10);
    const row = byDay.get(key) ?? { label, count: 0, revenue: 0 };
    row.count += 1;
    row.revenue += sale.total;
    byDay.set(key, row);
  }

  const days = Array.from(byDay.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const chartData = days.map(([, row]) => ({
    label: row.label,
    revenue: Math.round(row.revenue),
    transactions: row.count,
  }));

  const totalRevenue = periodSales.reduce((sum, s) => sum + s.total, 0);

  return {
    kpis: [
      currencyKpi(
        'Register Revenue',
        'revenue',
        totalRevenue,
        currency,
        '#059669',
        'wallet',
      ),
      countKpi('Trading Days', 'days', days.length, '#2563eb', 'calendar'),
      countKpi(
        'Transactions',
        'transactionCount',
        periodSales.length,
        '#9333ea',
        'receipt',
      ),
      currencyKpi(
        'Avg Daily Revenue',
        'avgDaily',
        days.length > 0 ? Math.round(totalRevenue / days.length) : 0,
        currency,
        '#e11d48',
        'calculator',
      ),
    ],
    charts: [
      {
        id: 'daily-register',
        title: 'Daily Register',
        subtitle: 'Revenue per trading day',
        type: 'bar',
        series: [{ name: 'Revenue', dataKey: 'revenue', color: '#059669' }],
        data:
          chartData.length > 0
            ? chartData
            : [{ label: '—', revenue: 0, transactions: 0 }],
      },
    ],
    table: {
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'transactions', header: 'Transactions' },
        { key: 'revenue', header: 'Revenue' },
        { key: 'avgTicket', header: 'Avg Ticket' },
      ],
      rows: days.map(([, row]) => ({
        date: row.label,
        transactions: row.count,
        revenue: Math.round(row.revenue),
        avgTicket: row.count > 0 ? Math.round(row.revenue / row.count) : 0,
        currency,
      })),
    },
  };
}

/** Sales representative — grouped by `createdByName` on sales. */
export async function buildSalesRepReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const sales = await db.sale.findMany({
    where: {
      deletedAt: null,
      status: { not: 'draft' },
      date: { gte: window.from, lte: window.to },
    },
    select: {
      id: true,
      total: true,
      currency: true,
      createdByName: true,
    },
  });

  const currency = sales[0]?.currency ?? 'NGN';
  const byRep = new Map<string, { count: number; revenue: number }>();

  for (const sale of sales) {
    const rep = sale.createdByName?.trim() || 'Unassigned';
    const row = byRep.get(rep) ?? { count: 0, revenue: 0 };
    row.count += 1;
    row.revenue += toNumber(sale.total);
    byRep.set(rep, row);
  }

  const rows = Array.from(byRep.entries())
    .map(([rep, stats]) => ({
      rep,
      transactions: stats.count,
      revenue: Math.round(stats.revenue),
      avgTicket: stats.count > 0 ? Math.round(stats.revenue / stats.count) : 0,
      currency,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const chartData = rows.slice(0, 12).map((row) => ({
    label: row.rep,
    revenue: row.revenue,
  }));

  const totalRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);

  return {
    kpis: [
      currencyKpi(
        'Total Revenue',
        'revenue',
        totalRevenue,
        currency,
        '#059669',
        'wallet',
      ),
      countKpi('Sales Staff', 'reps', rows.length, '#2563eb', 'users'),
      countKpi(
        'Transactions',
        'transactionCount',
        sales.length,
        '#9333ea',
        'receipt',
      ),
      currencyKpi(
        'Avg per Rep',
        'avgPerRep',
        rows.length > 0 ? Math.round(totalRevenue / rows.length) : 0,
        currency,
        '#e11d48',
        'calculator',
      ),
    ],
    charts: [
      {
        id: 'revenue-by-rep',
        title: 'Revenue by Sales Rep',
        subtitle: 'From sale creator on record',
        type: 'bar',
        horizontal: true,
        series: [{ name: 'Revenue', dataKey: 'revenue', color: '#059669' }],
        data: chartData.length > 0 ? chartData : [{ label: '—', revenue: 0 }],
      },
    ],
    table: {
      columns: [
        { key: 'rep', header: 'Sales Rep' },
        { key: 'transactions', header: 'Transactions' },
        { key: 'revenue', header: 'Revenue' },
        { key: 'avgTicket', header: 'Avg Ticket' },
      ],
      rows,
    },
  };
}

export async function buildSellPaymentReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const paymentRows = await db.payment.findMany({
    where: {
      deletedAt: null,
      OR: [
        { paidOn: { gte: window.from, lte: window.to } },
        { paidOn: null, createdAt: { gte: window.from, lte: window.to } },
      ],
    },
    select: {
      id: true,
      amount: true,
      method: true,
      currency: true,
      paidOn: true,
      createdAt: true,
      paymentRefNo: true,
      paymentFor: true,
      saleId: true,
      account: { select: { name: true } },
      sale: { select: { id: true, reference: true, date: true } },
    },
    orderBy: { paidOn: 'desc' },
    take: 500,
  });

  // Sell-side: linked to a sale, or legacy POS payment with no supplier/purchase target
  const payments = paymentRows.filter(
    (payment) => payment.saleId != null || !payment.paymentFor,
  );

  const currency = payments[0]?.currency ?? 'NGN';
  const total = payments.reduce((sum, p) => sum + toNumber(p.amount), 0);

  const byMethod = new Map<string, number>();
  for (const payment of payments) {
    const method = payment.method ?? 'other';
    byMethod.set(
      method,
      (byMethod.get(method) ?? 0) + toNumber(payment.amount),
    );
  }

  if (payments.length === 0) {
    const ctx = await loadSalesReportContext(db, from, to);
    const paidSales = ctx.periodSales.filter((s) => s.paymentStatus === 'paid');
    const partialSales = ctx.periodSales.filter(
      (s) => s.paymentStatus === 'partial',
    );
    const dueSales = ctx.periodSales.filter((s) => s.paymentStatus === 'due');

    const collected = paidSales.reduce((sum, s) => sum + s.total, 0);
    const partialAmount = partialSales.reduce((sum, s) => sum + s.total, 0);
    const dueAmount = dueSales.reduce((sum, s) => sum + s.total, 0);
    const salesTotal = ctx.periodSales.reduce((sum, s) => sum + s.total, 0);

    const statusAmounts = [
      { label: 'paid', value: Math.round(collected) },
      { label: 'partial', value: Math.round(partialAmount) },
      { label: 'due', value: Math.round(dueAmount) },
    ].filter((row) => row.value > 0);

    return {
      kpis: [
        currencyKpi(
          'Collected (paid)',
          'collected',
          collected,
          ctx.currency,
          '#059669',
          'wallet',
        ),
        currencyKpi(
          'Sales Value',
          'salesValue',
          salesTotal,
          ctx.currency,
          '#2563eb',
          'banknote',
        ),
        currencyKpi(
          'Outstanding',
          'outstanding',
          partialAmount + dueAmount,
          ctx.currency,
          '#e11d48',
          'clock',
        ),
        countKpi(
          'Transactions',
          'transactions',
          ctx.periodSales.length,
          '#9333ea',
          'receipt',
        ),
      ],
      charts: [
        {
          id: 'payment-status-amounts',
          title: 'Collections by Payment Status',
          subtitle:
            'Payment rows not migrated — amounts derived from sale payment status',
          type: 'pie',
          series: [{ name: 'Amount', dataKey: 'value', color: '#3b82f6' }],
          data: statusAmounts,
        },
      ],
      table: {
        columns: [
          { key: 'date', header: 'Date' },
          { key: 'reference', header: 'Sale' },
          { key: 'status', header: 'Status' },
          { key: 'amount', header: 'Amount' },
        ],
        rows: ctx.periodSales.slice(0, 200).map((sale) => ({
          id: sale.id,
          recordType: 'sale',
          date: sale.date.toISOString().slice(0, 10),
          reference: sale.id.slice(0, 8),
          status: sale.paymentStatus ?? '—',
          amount: Math.round(sale.total),
          currency: sale.currency,
        })),
      },
    };
  }

  return {
    kpis: [
      currencyKpi(
        'Collected',
        'collected',
        total,
        currency,
        '#059669',
        'wallet',
      ),
      countKpi(
        'Payments',
        'paymentCount',
        payments.length,
        '#2563eb',
        'banknote',
      ),
      countKpi('Methods', 'methods', byMethod.size, '#9333ea', 'credit-card'),
    ],
    charts: [
      {
        id: 'payments-by-method',
        title: 'Collections by Method',
        type: 'pie',
        series: [{ name: 'Amount', dataKey: 'value', color: '#059669' }],
        data: Array.from(byMethod.entries()).map(([label, value]) => ({
          label,
          value: Math.round(value),
        })),
      },
    ],
    table: {
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'reference', header: 'Sale' },
        { key: 'method', header: 'Method' },
        { key: 'account', header: 'Account' },
        { key: 'amount', header: 'Amount' },
      ],
      rows: payments.map((payment) => ({
        id: payment.id,
        recordType: 'payment',
        date: (payment.paidOn ?? payment.createdAt).toISOString().slice(0, 10),
        reference: payment.sale?.reference ?? payment.paymentRefNo ?? '—',
        method: payment.method ?? '—',
        account: payment.account?.name ?? '—',
        amount: Math.round(toNumber(payment.amount)),
        currency: payment.currency,
      })),
    },
  };
}

export async function buildPurchasePaymentReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const dateFilter = ledgerDateFilter(from, to);

  const [payments, accountDebits, expenseAgg, expenseRows] = await Promise.all([
    db.payment.findMany({
      where: {
        deletedAt: null,
        saleId: null,
        paymentFor: { not: null },
        OR: [
          { paidOn: { gte: window.from, lte: window.to } },
          { paidOn: null, createdAt: { gte: window.from, lte: window.to } },
        ],
      },
      select: {
        id: true,
        amount: true,
        method: true,
        currency: true,
        paymentFor: true,
        paidOn: true,
        createdAt: true,
        account: { select: { name: true } },
      },
      orderBy: { paidOn: 'desc' },
      take: 200,
    }),
    db.accountTransaction.findMany({
      where: {
        deletedAt: null,
        type: 'debit',
        operationDate: { gte: window.from, lte: window.to },
      },
      select: {
        id: true,
        amount: true,
        operationDate: true,
        note: true,
        paymentMethod: true,
        account: { select: { name: true } },
      },
      orderBy: { operationDate: 'desc' },
      take: 200,
    }),
    db.ledgerEntry.aggregate({
      where: { deletedAt: null, type: 'expense', ...dateFilter },
      _sum: { amount: true },
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
      take: 100,
    }),
  ]);

  const currency = payments[0]?.currency ?? expenseRows[0]?.currency ?? 'NGN';
  const paymentTotal = payments.reduce((sum, p) => sum + toNumber(p.amount), 0);
  const debitTotal = accountDebits.reduce(
    (sum, row) => sum + toNumber(row.amount),
    0,
  );
  const expenseTotal = toNumber(expenseAgg._sum.amount ?? 0);
  const total =
    paymentTotal > 0
      ? paymentTotal
      : debitTotal > 0
        ? debitTotal
        : expenseTotal;

  const tableRows =
    payments.length > 0
      ? payments.map((payment) => ({
          id: payment.id,
          recordType: 'payment',
          date: (payment.paidOn ?? payment.createdAt)
            .toISOString()
            .slice(0, 10),
          source: payment.paymentFor ?? 'Purchase payment',
          method: payment.method ?? '—',
          account: payment.account?.name ?? '—',
          amount: Math.round(toNumber(payment.amount)),
          currency: payment.currency,
        }))
      : accountDebits.length > 0
        ? accountDebits.map((row) => ({
            id: row.id,
            recordType: 'accountTransaction',
            date: row.operationDate.toISOString().slice(0, 10),
            source: row.note ?? 'Account debit',
            method: row.paymentMethod ?? '—',
            account: row.account.name,
            amount: Math.round(toNumber(row.amount)),
            currency,
          }))
        : expenseRows.map((row) => ({
            id: row.id,
            recordType: 'ledgerEntry',
            date: row.date.toISOString().slice(0, 10),
            source: row.category,
            method: '—',
            account: '—',
            amount: Math.round(toNumber(row.amount)),
            currency: row.currency,
          }));

  return {
    kpis: [
      currencyKpi(
        'Purchase Payments',
        'purchasePayments',
        total,
        currency,
        '#059669',
        'truck',
      ),
      currencyKpi(
        'Account Debits',
        'accountDebits',
        debitTotal,
        currency,
        '#2563eb',
        'banknote',
      ),
      currencyKpi(
        'Expenses (ledger)',
        'expenses',
        expenseTotal,
        currency,
        '#9333ea',
        'receipt',
      ),
      countKpi(
        'Records',
        'recordCount',
        tableRows.length,
        '#e11d48',
        'file-text',
      ),
    ],
    charts: [
      {
        id: 'purchase-payment-sources',
        title: 'Outflow Sources',
        type: 'bar',
        horizontal: true,
        series: [{ name: 'Amount', dataKey: 'value', color: '#2563eb' }],
        data: [
          { label: 'Payments', value: Math.round(paymentTotal) },
          { label: 'Account debits', value: Math.round(debitTotal) },
          { label: 'Expense ledger', value: Math.round(expenseTotal) },
        ].filter((row) => row.value > 0),
      },
    ],
    table: {
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'source', header: 'Source' },
        { key: 'account', header: 'Account' },
        { key: 'method', header: 'Method' },
        { key: 'amount', header: 'Amount' },
      ],
      rows: tableRows,
    },
  };
}

export async function buildContactsSummaryReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);

  const [customers, suppliers, sales] = await Promise.all([
    db.customer.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, phone: true, email: true },
      take: 5000,
    }),
    db.supplier.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, phone: true },
      take: 2000,
    }),
    db.sale.findMany({
      where: {
        deletedAt: null,
        status: { not: 'draft' },
        date: { gte: window.from, lte: window.to },
      },
      select: { customerId: true, total: true, currency: true },
    }),
  ]);

  const currency = sales[0]?.currency ?? 'NGN';
  const byCustomer = new Map<string, { count: number; revenue: number }>();
  let walkInCount = 0;
  let walkInRevenue = 0;

  for (const sale of sales) {
    if (!sale.customerId) {
      walkInCount += 1;
      walkInRevenue += toNumber(sale.total);
      continue;
    }
    const row = byCustomer.get(sale.customerId) ?? { count: 0, revenue: 0 };
    row.count += 1;
    row.revenue += toNumber(sale.total);
    byCustomer.set(sale.customerId, row);
  }

  const customerRows = customers
    .map((customer) => {
      const stats = byCustomer.get(customer.id);
      return {
        name: customer.name,
        phone: customer.phone ?? '—',
        transactions: stats?.count ?? 0,
        revenue: Math.round(stats?.revenue ?? 0),
        currency,
      };
    })
    .filter((row) => row.transactions > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 100);

  const supplierRows = suppliers.slice(0, 50).map((supplier) => ({
    name: supplier.name,
    phone: supplier.phone ?? '—',
    type: 'Supplier',
  }));

  return {
    kpis: [
      countKpi('Customers', 'customers', customers.length, '#059669', 'users'),
      countKpi('Suppliers', 'suppliers', suppliers.length, '#2563eb', 'truck'),
      countKpi('Walk-in Sales', 'walkIn', walkInCount, '#9333ea', 'user'),
      currencyKpi(
        'Walk-in Revenue',
        'walkInRevenue',
        Math.round(walkInRevenue),
        currency,
        '#e11d48',
        'wallet',
      ),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'name', header: 'Contact' },
        { key: 'phone', header: 'Phone' },
        { key: 'transactions', header: 'Sales' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: [
        ...customerRows,
        ...supplierRows.map((s) => ({
          name: s.name,
          phone: s.phone,
          transactions: 0,
          revenue: 0,
        })),
      ],
    },
  };
}

export async function buildCustomerGroupsReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const sales = await db.sale.findMany({
    where: {
      deletedAt: null,
      status: { not: 'draft' },
      date: { gte: window.from, lte: window.to },
    },
    select: {
      total: true,
      currency: true,
      customerId: true,
      customer: { select: { name: true } },
    },
  });

  const currency = sales[0]?.currency ?? 'NGN';
  const groups = new Map<string, { count: number; revenue: number }>();

  for (const sale of sales) {
    const group = sale.customerId
      ? sale.customer?.name?.trim().charAt(0).toUpperCase() || 'Account'
      : 'Walk-in';
    const row = groups.get(group) ?? { count: 0, revenue: 0 };
    row.count += 1;
    row.revenue += toNumber(sale.total);
    groups.set(group, row);
  }

  const rows = Array.from(groups.entries())
    .map(([group, stats]) => ({
      group,
      transactions: stats.count,
      revenue: Math.round(stats.revenue),
      currency,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    kpis: [
      countKpi(
        'Customer Segments',
        'segments',
        rows.length,
        '#059669',
        'users',
      ),
      countKpi(
        'Transactions',
        'transactionCount',
        sales.length,
        '#2563eb',
        'receipt',
      ),
      currencyKpi(
        'Total Revenue',
        'revenue',
        rows.reduce((sum, r) => sum + r.revenue, 0),
        currency,
        '#9333ea',
        'wallet',
      ),
    ],
    charts: [
      {
        id: 'revenue-by-segment',
        title: 'Revenue by Customer Segment',
        subtitle: 'Walk-in vs account customers (A–Z bucket for accounts)',
        type: 'bar',
        horizontal: true,
        series: [{ name: 'Revenue', dataKey: 'revenue', color: '#059669' }],
        data: rows
          .slice(0, 15)
          .map((row) => ({ label: row.group, revenue: row.revenue })),
      },
    ],
    table: {
      columns: [
        { key: 'group', header: 'Segment' },
        { key: 'transactions', header: 'Transactions' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows,
    },
  };
}

export async function buildTrendingProductsReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const ctx = await loadSalesReportContext(db, from, to);
  const topCurrent = aggregateTopProducts(ctx.periodSales, 15);
  const topPrior = aggregateTopProducts(ctx.priorSales, 15);
  const priorBySku = new Map(
    topPrior.map((row) => [row.sku.toLowerCase(), row.units]),
  );

  const rows = topCurrent.map((row) => {
    const priorUnits = priorBySku.get(row.sku.toLowerCase()) ?? 0;
    return {
      sku: row.sku,
      name: row.label,
      units: Math.round(row.units * 100) / 100,
      priorUnits,
      revenue: Math.round(row.revenue),
      currency: ctx.currency,
    };
  });

  return {
    kpis: [
      countKpi('Products Sold', 'products', rows.length, '#059669', 'package'),
      countKpi(
        'Units (period)',
        'units',
        Math.round(rows.reduce((s, r) => s + r.units, 0)),
        '#2563eb',
        'box',
      ),
      currencyKpi(
        'Line Revenue',
        'revenue',
        Math.round(rows.reduce((s, r) => s + r.revenue, 0)),
        ctx.currency,
        '#9333ea',
        'wallet',
      ),
    ],
    charts: [
      {
        id: 'trending-units',
        title: 'Trending Products',
        subtitle: 'Units sold in selected period',
        type: 'bar',
        horizontal: true,
        series: [{ name: 'Units', dataKey: 'units', color: '#3b82f6' }],
        data: rows
          .slice(0, 12)
          .map((row) => ({ label: row.name, units: row.units })),
      },
    ],
    table: {
      columns: [
        { key: 'sku', header: 'SKU' },
        { key: 'name', header: 'Product' },
        { key: 'units', header: 'Units' },
        { key: 'priorUnits', header: 'Prior Units' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows,
    },
  };
}

export async function buildItemsReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const ctx = await loadSalesReportContext(db, from, to);
  const aggregated = aggregateTopProducts(ctx.periodSales, 500);
  const itemIds = aggregated
    .map((row) => row.itemId)
    .filter((id): id is string => Boolean(id));

  const items =
    itemIds.length > 0
      ? await db.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, quantity: true, status: true, costPrice: true },
        })
      : [];
  const itemById = new Map(items.map((item) => [item.id, item]));

  const rows = aggregated.map((row) => {
    const item = row.itemId ? itemById.get(row.itemId) : undefined;
    return {
      sku: row.sku,
      name: row.label,
      unitsSold: Math.round(row.units * 100) / 100,
      revenue: Math.round(row.revenue),
      onHand: item?.quantity ?? '—',
      status: item?.status ?? '—',
      currency: ctx.currency,
    };
  });

  return {
    kpis: [
      countKpi('SKUs Sold', 'skus', rows.length, '#059669', 'package'),
      countKpi(
        'Units Sold',
        'units',
        Math.round(rows.reduce((s, r) => s + Number(r.unitsSold), 0)),
        '#2563eb',
        'box',
      ),
      currencyKpi(
        'Revenue',
        'revenue',
        Math.round(rows.reduce((s, r) => s + Number(r.revenue), 0)),
        ctx.currency,
        '#9333ea',
        'wallet',
      ),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'sku', header: 'SKU' },
        { key: 'name', header: 'Product' },
        { key: 'unitsSold', header: 'Units Sold' },
        { key: 'onHand', header: 'On Hand' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows,
    },
  };
}

export async function buildProductSellReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  return buildItemsReport(db, from, to);
}

export async function buildProductPurchaseReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const inbound = await db.stockMovement.findMany({
    where: {
      deletedAt: null,
      type: 'inbound',
      date: { gte: window.from, lte: window.to },
    },
    select: { reference: true, date: true, lines: true },
    take: 500,
  });

  const rows: Array<Record<string, string | number>> = [];
  for (const movement of inbound) {
    const lines = Array.isArray(movement.lines) ? movement.lines : [];
    for (const raw of lines) {
      if (!raw || typeof raw !== 'object') continue;
      const line = raw as Record<string, unknown>;
      rows.push({
        reference: movement.reference,
        date: movement.date.toISOString().slice(0, 10),
        sku: toStringField(line.sku) || toStringField(line.name) || '—',
        quantity: toNumber(line.quantity as number | string),
      });
    }
  }

  return {
    kpis: [
      countKpi('Inbound Docs', 'inbound', inbound.length, '#059669', 'truck'),
      countKpi('Line Items', 'lines', rows.length, '#2563eb', 'package'),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'reference', header: 'Reference' },
        { key: 'sku', header: 'SKU' },
        { key: 'quantity', header: 'Qty' },
      ],
      rows: rows.slice(0, 200),
    },
  };
}

export async function buildStockExpiryReport(
  db: TenantScopedPrisma,
): Promise<ReportsDashboard> {
  const lowItems = await db.item.findMany({
    where: {
      deletedAt: null,
      OR: [
        { status: 'low_stock' },
        { status: 'out_of_stock' },
        { reorderPoint: { not: null }, quantity: { lte: 0 } },
      ],
    },
    select: {
      sku: true,
      name: true,
      quantity: true,
      reorderPoint: true,
      status: true,
    },
    orderBy: { quantity: 'asc' },
    take: 200,
  });

  return {
    kpis: [
      countKpi(
        'At-risk SKUs',
        'atRisk',
        lowItems.length,
        '#e11d48',
        'alert-triangle',
      ),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'sku', header: 'SKU' },
        { key: 'name', header: 'Product' },
        { key: 'quantity', header: 'On Hand' },
        { key: 'reorderPoint', header: 'Reorder At' },
        { key: 'status', header: 'Status' },
      ],
      rows: lowItems.map((item) => ({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        reorderPoint: item.reorderPoint ?? '—',
        status: item.status,
        note: 'Expiry dates not tracked — showing low/out-of-stock SKUs',
      })),
    },
  };
}
