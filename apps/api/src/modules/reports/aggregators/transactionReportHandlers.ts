import type {
  ReportRowAction,
  ReportRunOptions,
  ReportsDashboard,
  ReportsTable,
  ReportsTableRow,
  TaxReportSummary,
} from '@vonos/types';
import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { ledgerDateFilter } from '../../../common/utils/ledgerAggregates';
import { parseMovementLines } from '../../../common/utils/stockQuantity';
import { runPool } from '../../../common/utils/mapPool';
import { toNumber } from '../../../common/utils/serializers';
import {
  computeDelta,
  resolveDateWindow,
} from './date-utils';
import {
  ledgerCostByBucket,
  priorWindow,
  periodSaleRefsPage,
  periodPurchaseRefsPage,
  salesByCreatedBy,
  salesByDay,
  salesByServiceStaff,
  salesRevenueByBucket,
  sumSalesWindow,
  taxReportSummaryAggregates,
  topProductsSold,
  type PeriodInvoicePage,
  type PeriodInvoiceRef,
} from './salesReportQueries';

const NEON_QUERY_CONCURRENCY = 2;

export {
  buildItemsReport,
  buildProductPurchaseReport,
  buildProductSellReport,
  buildSellPaymentReport,
} from './tableReportHandlers';

function periodDocTypeLabel(row: PeriodInvoiceRef): string {
  if (row.recordType === 'purchase') return 'Purchase';
  if (row.recordType === 'job') return 'Job Invoice';
  return 'Sale';
}

function mapPeriodInvoiceRows(
  rows: PeriodInvoiceRef[],
  currency: string,
): ReportsTableRow[] {
  return rows.map((row) => ({
    id: row.recordType === 'job' && row.jobId ? row.jobId : row.id,
    recordType:
      row.recordType === 'job'
        ? ('job' as const)
        : row.recordType === 'purchase'
          ? ('purchase' as const)
          : ('sale' as const),
    saleId: row.recordType === 'sale' ? row.id : undefined,
    date: row.date.toISOString().slice(0, 16).replace('T', ' '),
    type: periodDocTypeLabel(row),
    reference: row.reference,
    invoiceNo: row.invoiceNo,
    party: row.party,
    createdBy: row.createdByName ?? '—',
    location: row.locationCode ?? '—',
    payment: row.paymentStatus ?? row.paymentMethod ?? '—',
    paymentMethod: row.paymentMethod ?? '—',
    discount: Math.round(row.discount * 100) / 100,
    tax: Math.round(row.tax * 100) / 100,
    vat: Math.round(row.tax * 100) / 100,
    taxNumber: row.taxNumber?.trim() || '—',
    total: Math.round(row.total * 100) / 100,
    currency,
  }));
}

function periodInvoiceColumns(detailed = false) {
  const base = [
    { key: 'date', header: 'Date' },
    { key: 'type', header: 'Type' },
    { key: 'invoiceNo', header: 'Invoice No.' },
    { key: 'reference', header: 'Reference No' },
    { key: 'party', header: 'Customer / Supplier' },
  ];
  if (detailed) {
    return [
      ...base,
      { key: 'taxNumber', header: 'Tax number' },
      { key: 'paymentMethod', header: 'Payment Method' },
      { key: 'discount', header: 'Discount', totalAs: 'currency' as const },
      { key: 'vat', header: 'VAT', totalAs: 'currency' as const },
      { key: 'createdBy', header: 'Added By' },
      { key: 'location', header: 'Location' },
      { key: 'payment', header: 'Payment' },
      { key: 'total', header: 'Total amount', totalAs: 'currency' as const },
    ];
  }
  return [
    ...base,
    { key: 'createdBy', header: 'Added By' },
    { key: 'location', header: 'Location' },
    { key: 'payment', header: 'Payment' },
    { key: 'total', header: 'Total', totalAs: 'currency' as const },
  ];
}

function periodPageToTable(
  page: PeriodInvoicePage,
  currency: string,
  detailed: boolean,
): ReportsTable {
  const rows = mapPeriodInvoiceRows(page.rows, currency);
  return {
    columns: periodInvoiceColumns(detailed),
    rows,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    pageSize: page.pageSize,
    columnTotals: {
      discount:
        Math.round(
          rows.reduce((sum, row) => sum + Number(row.discount ?? 0), 0) * 100,
        ) / 100,
      vat:
        Math.round(
          rows.reduce((sum, row) => sum + Number(row.vat ?? 0), 0) * 100,
        ) / 100,
      total: Math.round(
        rows.reduce((sum, row) => sum + Number(row.total ?? 0), 0),
      ),
    },
  };
}

function emptyPeriodTable(detailed: boolean, pageSize: number): ReportsTable {
  return {
    columns: periodInvoiceColumns(detailed),
    rows: [],
    hasMore: false,
    nextCursor: null,
    pageSize,
    columnTotals: { discount: 0, vat: 0, total: 0 },
  };
}

async function loadTaxTables(
  db: TenantScopedPrisma,
  tenantId: string,
  window: ReturnType<typeof resolveDateWindow>,
  currency: string,
  detailed: boolean,
  options?: ReportRunOptions,
): Promise<{ purchases: ReportsTable; sales: ReportsTable; combined: ReportsTable }> {
  const pageOpts = {
    cursor: options?.cursor,
    limit: options?.limit,
    search: options?.search,
  };
  const side = options?.taxTable;

  if (side === 'purchases') {
    const purchasesPage = await periodPurchaseRefsPage(
      db,
      tenantId,
      window,
      pageOpts,
    );
    const purchases = periodPageToTable(purchasesPage, currency, detailed);
    return {
      purchases,
      sales: emptyPeriodTable(detailed, purchasesPage.pageSize),
      combined: purchases,
    };
  }

  if (side === 'sales') {
    const salesPage = await periodSaleRefsPage(db, tenantId, window, pageOpts);
    const sales = periodPageToTable(salesPage, currency, detailed);
    return {
      purchases: emptyPeriodTable(detailed, salesPage.pageSize),
      sales,
      combined: sales,
    };
  }

  const [salesPage, purchasesPage] = await Promise.all([
    periodSaleRefsPage(db, tenantId, window, {
      limit: pageOpts.limit,
      search: pageOpts.search,
    }),
    periodPurchaseRefsPage(db, tenantId, window, {
      limit: pageOpts.limit,
      search: pageOpts.search,
    }),
  ]);
  const sales = periodPageToTable(salesPage, currency, detailed);
  const purchases = periodPageToTable(purchasesPage, currency, detailed);
  const combinedRows = [...sales.rows, ...purchases.rows].sort((a, b) =>
    String(b.date).localeCompare(String(a.date)),
  );
  return {
    purchases,
    sales,
    combined: {
      columns: periodInvoiceColumns(detailed),
      rows: combinedRows,
      pageSize: salesPage.pageSize,
      columnTotals: {
        discount:
          Math.round(
            ((sales.columnTotals?.discount ?? 0) +
              (purchases.columnTotals?.discount ?? 0)) *
              100,
          ) / 100,
        vat:
          Math.round(
            ((sales.columnTotals?.vat ?? 0) +
              (purchases.columnTotals?.vat ?? 0)) *
              100,
          ) / 100,
        total:
          (sales.columnTotals?.total ?? 0) +
          (purchases.columnTotals?.total ?? 0),
      },
    },
  };
}

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

function paymentRowActions(paymentId: string): ReportRowAction[] {
  return [
    {
      kind: 'view-record',
      label: 'View',
      payload: { paymentId, recordType: 'payment' },
    },
    {
      kind: 'edit-payment',
      label: 'Edit payment',
      payload: { paymentId },
    },
  ];
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

/** Purchase & Sale — sales revenue vs ledger cost (SQL aggregates). */
export async function buildPurchaseSaleReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);
  const pagingOnly = Boolean(options?.taxTable && options?.cursor);

  const [period, priorPeriod, purchaseAgg, priorPurchaseAgg, salesBuckets, costBuckets, summary] =
    await runPool(
      [
        () =>
          pagingOnly
            ? Promise.resolve({ revenue: 0, count: 0, currency: 'NGN' })
            : sumSalesWindow(db, tenantId, window),
        () =>
          pagingOnly
            ? Promise.resolve({ revenue: 0, count: 0, currency: 'NGN' })
            : sumSalesWindow(db, tenantId, prior),
        () =>
          pagingOnly
            ? Promise.resolve({ _sum: { amount: null as null } })
            : db.ledgerEntry.aggregate({
                where: {
                  deletedAt: null,
                  type: 'cost',
                  date: { gte: window.from, lte: window.to },
                },
                _sum: { amount: true },
              }),
        () =>
          pagingOnly
            ? Promise.resolve({ _sum: { amount: null as null } })
            : db.ledgerEntry.aggregate({
                where: {
                  deletedAt: null,
                  type: 'cost',
                  date: { gte: prior.from, lte: prior.to },
                },
                _sum: { amount: true },
              }),
        () =>
          pagingOnly
            ? Promise.resolve(
                [] as Awaited<ReturnType<typeof salesRevenueByBucket>>,
              )
            : salesRevenueByBucket(db, tenantId, window),
        () =>
          pagingOnly
            ? Promise.resolve(
                [] as Awaited<ReturnType<typeof ledgerCostByBucket>>,
              )
            : ledgerCostByBucket(db, tenantId, window),
        () => taxReportSummaryAggregates(db, tenantId, window),
      ],
      NEON_QUERY_CONCURRENCY,
    );

  const currency = summary.currency || period.currency;
  const tables = await loadTaxTables(
    db,
    tenantId,
    window,
    currency,
    false,
    options,
  );

  const purchases = toNumber(purchaseAgg._sum.amount ?? 0);
  const priorPurchases = toNumber(priorPurchaseAgg._sum.amount ?? 0);
  const salesTotal = period.revenue;
  const grossProfit = salesTotal - purchases;

  const purchaseByKey = new Map(
    costBuckets.map((row) => [row.key, row.purchases]),
  );
  const chartData = salesBuckets.map((row) => ({
    label: row.label,
    sales: Math.round(row.sales),
    purchases: Math.round(purchaseByKey.get(row.key) ?? 0),
  }));
  for (const cost of costBuckets) {
    if (salesBuckets.some((s) => s.key === cost.key)) continue;
    chartData.push({
      label: cost.key,
      sales: 0,
      purchases: Math.round(cost.purchases),
    });
  }
  chartData.sort((a, b) => a.label.localeCompare(b.label));

  const saleMinusPurchase =
    summary.saleIncludingTax -
    summary.sellReturnIncludingTax -
    (summary.purchaseIncludingTax - summary.purchaseReturnIncludingTax);
  const dueAmount = summary.saleDue - summary.purchaseDue;

  const taxReport: TaxReportSummary = {
    currency: summary.currency,
    purchases: {
      total: summary.totalPurchase,
      includingTax: summary.purchaseIncludingTax,
      returnIncludingTax: summary.purchaseReturnIncludingTax,
      due: summary.purchaseDue,
    },
    sales: {
      total: summary.totalSale,
      includingTax: summary.saleIncludingTax,
      returnIncludingTax: summary.sellReturnIncludingTax,
      due: summary.saleDue,
    },
    overall: {
      saleMinusPurchase,
      dueAmount,
    },
  };

  if (pagingOnly) {
    return {
      kpis: [],
      charts: [],
      taxReport,
      taxTables: { purchases: tables.purchases, sales: tables.sales },
      table: tables.combined,
    };
  }

  return {
    kpis: [
      currencyKpi(
        'Total Sales',
        'sales',
        salesTotal,
        currency,
        '#059669',
        'wallet',
        computeDelta(salesTotal, priorPeriod.revenue),
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
        period.count,
        '#e11d48',
        'receipt',
        computeDelta(period.count, priorPeriod.count),
      ),
      currencyKpi(
        'Sale - Purchase',
        'saleMinusPurchase',
        saleMinusPurchase,
        summary.currency,
        '#0d9488',
        'trending-up',
      ),
      currencyKpi(
        'Due amount',
        'dueAmount',
        dueAmount,
        summary.currency,
        '#0d9488',
        'wallet',
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
    taxReport,
    taxTables: { purchases: tables.purchases, sales: tables.sales },
    table: tables.combined,
  };
}

/** Tax — Ultimate POS Purchases / Sales / Overall cards + period invoices. */
export async function buildTaxReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const pagingOnly = Boolean(options?.taxTable && options?.cursor);

  const summary = await taxReportSummaryAggregates(db, tenantId, window);
  const tables = await loadTaxTables(
    db,
    tenantId,
    window,
    summary.currency,
    true,
    options,
  );

  const saleMinusPurchase =
    summary.saleIncludingTax -
    summary.sellReturnIncludingTax -
    (summary.purchaseIncludingTax - summary.purchaseReturnIncludingTax);
  const dueAmount = summary.saleDue - summary.purchaseDue;

  const taxReport: TaxReportSummary = {
    currency: summary.currency,
    purchases: {
      total: summary.totalPurchase,
      includingTax: summary.purchaseIncludingTax,
      returnIncludingTax: summary.purchaseReturnIncludingTax,
      due: summary.purchaseDue,
    },
    sales: {
      total: summary.totalSale,
      includingTax: summary.saleIncludingTax,
      returnIncludingTax: summary.sellReturnIncludingTax,
      due: summary.saleDue,
    },
    overall: {
      saleMinusPurchase,
      dueAmount,
    },
  };

  if (pagingOnly) {
    return {
      kpis: [],
      charts: [],
      taxReport,
      taxTables: { purchases: tables.purchases, sales: tables.sales },
      table: tables.combined,
    };
  }

  return {
    kpis: [
      currencyKpi(
        'Sale - Purchase',
        'saleMinusPurchase',
        saleMinusPurchase,
        summary.currency,
        '#0d9488',
        'trending-up',
      ),
      currencyKpi(
        'Due amount',
        'dueAmount',
        dueAmount,
        summary.currency,
        '#0d9488',
        'wallet',
      ),
      currencyKpi(
        'Total Sale',
        'totalSale',
        summary.totalSale,
        summary.currency,
        '#059669',
        'receipt',
      ),
      currencyKpi(
        'Total Purchase',
        'totalPurchase',
        summary.totalPurchase,
        summary.currency,
        '#2563eb',
        'truck',
      ),
    ],
    charts: [],
    taxReport,
    taxTables: { purchases: tables.purchases, sales: tables.sales },
    table: tables.combined,
  };
}

/** Register — daily till summary from SQL. */
export async function buildRegisterReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const [days, period] = await Promise.all([
    salesByDay(db, tenantId, window),
    sumSalesWindow(db, tenantId, window),
  ]);

  const chartData = days.map((row) => ({
    label: row.label,
    revenue: Math.round(row.revenue),
    transactions: row.count,
  }));

  return {
    kpis: [
      currencyKpi(
        'Register Revenue',
        'revenue',
        period.revenue,
        period.currency,
        '#059669',
        'wallet',
      ),
      countKpi('Trading Days', 'days', days.length, '#2563eb', 'calendar'),
      countKpi(
        'Transactions',
        'transactionCount',
        period.count,
        '#9333ea',
        'receipt',
      ),
      currencyKpi(
        'Avg Daily Revenue',
        'avgDaily',
        days.length > 0 ? Math.round(period.revenue / days.length) : 0,
        period.currency,
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
      rows: days.slice(-90).map((row) => ({
        date: row.label,
        transactions: row.count,
        revenue: Math.round(row.revenue),
        avgTicket: row.count > 0 ? Math.round(row.revenue / row.count) : 0,
        currency: period.currency,
      })),
    },
  };
}

/** Sales representative — SQL group by createdByName. */
export async function buildSalesRepReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const byRep = await salesByCreatedBy(db, tenantId, window);
  const currency = byRep[0]?.currency ?? 'NGN';

  const rows = byRep.map((row) => ({
    rep: row.staff,
    transactions: row.count,
    revenue: Math.round(row.revenue),
    avgTicket: row.count > 0 ? Math.round(row.revenue / row.count) : 0,
    currency,
  }));

  const chartData = rows.slice(0, 12).map((row) => ({
    label: row.rep,
    revenue: row.revenue,
  }));

  const totalRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);
  const totalTx = rows.reduce((sum, r) => sum + r.transactions, 0);

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
      countKpi('Transactions', 'transactionCount', totalTx, '#9333ea', 'receipt'),
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


export async function buildPurchasePaymentReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const dateFilter = ledgerDateFilter(from, to);
  const pageSize = Math.min(Math.max(options?.limit ?? 25, 1), 100);
  const search = options?.search?.trim().toLowerCase() ?? '';

  const fetchCap = Math.min(Math.max(pageSize * 5, 50), 150);

  const [payments, accountDebits, expenseAgg, expenseRows] = await runPool(
    [
      () =>
        db.payment.findMany({
          where: {
            deletedAt: null,
            saleId: null,
            paymentFor: { not: null },
            ...(options?.paymentMethod
              ? { method: options.paymentMethod }
              : {}),
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
          orderBy: [{ paidOn: 'desc' }, { id: 'desc' }],
          take: fetchCap,
        }),
      () =>
        db.accountTransaction.findMany({
          where: {
            deletedAt: null,
            type: 'debit',
            operationDate: { gte: window.from, lte: window.to },
            ...(options?.paymentMethod
              ? { paymentMethod: options.paymentMethod }
              : {}),
          },
          select: {
            id: true,
            amount: true,
            operationDate: true,
            note: true,
            paymentMethod: true,
            account: { select: { name: true } },
          },
          orderBy: [{ operationDate: 'desc' }, { id: 'desc' }],
          take: fetchCap,
        }),
      () =>
        db.ledgerEntry.aggregate({
          where: { deletedAt: null, type: 'expense', ...dateFilter },
          _sum: { amount: true },
        }),
      () =>
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
          orderBy: [{ date: 'desc' }, { id: 'desc' }],
          take: fetchCap,
        }),
    ],
    NEON_QUERY_CONCURRENCY,
  );

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

  let tableRows: ReportsTableRow[] =
    payments.length > 0
      ? payments.map((payment) => ({
          id: payment.id,
          recordType: 'payment',
          date: (payment.paidOn ?? payment.createdAt)
            .toISOString()
            .slice(0, 10),
          sortAt: (payment.paidOn ?? payment.createdAt).toISOString(),
          source: payment.paymentFor ?? 'Purchase payment',
          method: payment.method ?? '—',
          account: payment.account?.name ?? '—',
          amount: Math.round(toNumber(payment.amount)),
          currency: payment.currency,
          actions: paymentRowActions(payment.id),
        }))
      : accountDebits.length > 0
        ? accountDebits.map((row) => ({
            id: row.id,
            recordType: 'accountTransaction',
            date: row.operationDate.toISOString().slice(0, 10),
            sortAt: row.operationDate.toISOString(),
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
            sortAt: row.date.toISOString(),
            source: row.category,
            method: '—',
            account: '—',
            amount: Math.round(toNumber(row.amount)),
            currency: row.currency,
          }));

  if (search) {
    tableRows = tableRows.filter((row) => {
      const hay = [
        row.source,
        row.account,
        row.method,
        row.date,
        row.amount,
      ]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      return hay.includes(search);
    });
  }

  const filteredCount = tableRows.length;

  // Cursor over sortAt + id
  if (options?.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(options.cursor, 'base64url').toString('utf8'),
      ) as { sortAt?: string; id?: string };
      if (decoded.sortAt && decoded.id) {
        tableRows = tableRows.filter((row) => {
          const sortAt = String(row.sortAt ?? row.date ?? '');
          if (sortAt < decoded.sortAt!) return true;
          if (sortAt > decoded.sortAt!) return false;
          return String(row.id) < decoded.id!;
        });
      }
    } catch {
      // ignore bad cursor
    }
  }

  const hasMore = tableRows.length > pageSize;
  const page = hasMore ? tableRows.slice(0, pageSize) : tableRows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            sortAt: String(last.sortAt ?? last.date ?? ''),
            id: String(last.id),
          }),
        ).toString('base64url')
      : null;

  const pageRows = page.map(({ sortAt: _sortAt, ...row }) => row);

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
      countKpi('Records', 'recordCount', filteredCount, '#e11d48', 'file-text'),
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
      rows: pageRows,
      hasMore,
      nextCursor,
      pageSize,
      columnTotals: {
        amount: Math.round(total * 100) / 100,
      },
    },
  };
}

export async function buildContactsSummaryReport(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);

  const [customerCount, supplierCount, saleStats, suppliers] =
    await runPool(
      [
        () => db.customer.count({ where: { deletedAt: null } }),
        () => db.supplier.count({ where: { deletedAt: null } }),
        () =>
          db.sale.groupBy({
            by: ['customerId'],
            where: {
              deletedAt: null,
              status: { not: 'draft' },
              date: { gte: window.from, lte: window.to },
            },
            _count: { _all: true },
            _sum: { total: true },
          }),
        () =>
          db.supplier.findMany({
            where: { deletedAt: null },
            select: { name: true, phone: true },
            orderBy: { name: 'asc' },
            take: 50,
          }),
      ],
      NEON_QUERY_CONCURRENCY,
    );

  let walkInCount = 0;
  let walkInRevenue = 0;
  const customerStats: Array<{
    customerId: string;
    count: number;
    revenue: number;
  }> = [];

  for (const row of saleStats) {
    const count = row._count._all;
    const revenue = toNumber(row._sum.total ?? 0);
    if (!row.customerId) {
      walkInCount += count;
      walkInRevenue += revenue;
      continue;
    }
    customerStats.push({
      customerId: row.customerId,
      count,
      revenue,
    });
  }

  customerStats.sort((a, b) => b.revenue - a.revenue);
  const top = customerStats.slice(0, 100);
  const currency = 'NGN';

  const customers =
    top.length > 0
      ? await db.customer.findMany({
          where: {
            deletedAt: null,
            id: { in: top.map((row) => row.customerId) },
          },
          select: { id: true, name: true, phone: true },
        })
      : [];
  const customerById = new Map(customers.map((c) => [c.id, c]));

  const customerRows = top
    .map((stats) => {
      const customer = customerById.get(stats.customerId);
      if (!customer) return null;
      return {
        id: customer.id,
        recordType: 'customer',
        name: customer.name,
        phone: customer.phone ?? '—',
        transactions: stats.count,
        revenue: Math.round(stats.revenue),
        currency,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);

  const supplierRows = suppliers.map((supplier) => ({
    name: supplier.name,
    phone: supplier.phone ?? '—',
    type: 'Supplier',
  }));

  return {
    kpis: [
      countKpi('Customers', 'customers', customerCount, '#059669', 'users'),
      countKpi('Suppliers', 'suppliers', supplierCount, '#2563eb', 'truck'),
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
  tenantId: string,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const pageSize = Math.min(Math.max(options?.limit ?? 25, 1), 100);
  const search = options?.search?.trim() ?? '';

  const locationClause = options?.locationCode
    ? Prisma.sql`AND s."locationCode" = ${options.locationCode}`
    : Prisma.empty;
  const groupFilterClause = options?.customerGroupId
    ? Prisma.sql`AND cg.id = ${options.customerGroupId}`
    : Prisma.empty;
  const includeNoGroup = !options?.customerGroupId;
  const searchClause = search
    ? Prisma.sql`WHERE "group" ILIKE ${'%' + search + '%'}`
    : Prisma.empty;

  type GroupSaleRow = {
    id: string;
    group: string;
    transactions: bigint;
    total_sale: Prisma.Decimal;
  };

  const [tableRowsRaw, currencyRow] = await Promise.all([
    db.$queryRaw<GroupSaleRow[]>`
      WITH sales_agg AS (
        SELECT
          c."customerGroupId" AS group_id,
          COUNT(*)::bigint AS tx_count,
          COALESCE(SUM(s.total), 0) AS revenue
        FROM "Sale" s
        LEFT JOIN "Customer" c ON c.id = s."customerId" AND c."deletedAt" IS NULL
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text <> 'draft'
          AND s.date >= ${window.from}
          AND s.date <= ${window.to}
          ${locationClause}
        GROUP BY c."customerGroupId"
      ),
      group_rows AS (
        SELECT
          cg.id::text AS id,
          cg.name AS "group",
          COALESCE(sa.tx_count, 0)::bigint AS transactions,
          COALESCE(sa.revenue, 0) AS total_sale
        FROM "CustomerGroup" cg
        LEFT JOIN sales_agg sa ON sa.group_id = cg.id
        WHERE cg."tenantId" = ${tenantId}
          AND cg."deletedAt" IS NULL
          ${groupFilterClause}

        ${
          includeNoGroup
            ? Prisma.sql`
                UNION ALL
                SELECT
                  '__none__'::text,
                  'No Group'::text,
                  sa.tx_count,
                  sa.revenue
                FROM sales_agg sa
                WHERE sa.group_id IS NULL AND sa.tx_count > 0
              `
            : Prisma.empty
        }
      )
      SELECT id, "group", transactions, total_sale
      FROM group_rows
      ${searchClause}
      ORDER BY total_sale DESC, id ASC
    `,
    db.sale.findFirst({
      where: { tenantId, deletedAt: null },
      select: { currency: true },
      orderBy: { id: 'asc' },
    }),
  ]);

  const currency = currencyRow?.currency ?? 'NGN';
  const tableRows = tableRowsRaw.map((row) => ({
    id: row.id,
    group: row.group,
    transactions: Number(row.transactions),
    totalSale: Math.round(toNumber(row.total_sale) * 100) / 100,
    currency,
  }));

  const grandTotal = tableRows.reduce((s, r) => s + r.totalSale, 0);
  const grandTx = tableRows.reduce((s, r) => s + r.transactions, 0);

  let start = 0;
  if (options?.cursor) {
    const idx = tableRows.findIndex((r) => r.id === options.cursor);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = tableRows.slice(start, start + pageSize);
  const last = page[page.length - 1];
  const pageHasMore = start + pageSize < tableRows.length;

  return {
    kpis: [
      countKpi('Customer Groups', 'segments', tableRows.length, '#059669', 'users'),
      countKpi('Transactions', 'transactionCount', grandTx, '#2563eb', 'receipt'),
      currencyKpi('Total Sale', 'revenue', grandTotal, currency, '#9333ea', 'wallet'),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'group', header: 'Customer Group' },
        { key: 'totalSale', header: 'Total Sale' },
      ],
      rows: page.map((row) => ({
        id: row.id,
        group: row.group,
        totalSale: row.totalSale,
        currency: row.currency,
      })),
      hasMore: pageHasMore,
      nextCursor: pageHasMore && last ? last.id : null,
      pageSize,
      columnTotals: {
        totalSale: Math.round(grandTotal * 100) / 100,
      },
    },
  };
}

export async function buildTrendingProductsReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);
  const [topCurrent, topPrior, period] = await Promise.all([
    topProductsSold(db, tenantId, window, 15),
    topProductsSold(db, tenantId, prior, 15),
    sumSalesWindow(db, tenantId, window),
  ]);
  const priorBySku = new Map(
    topPrior.map((row) => [row.sku.toLowerCase(), row.units]),
  );

  const rows = topCurrent.map((row) => {
    const priorUnits = priorBySku.get(row.sku.toLowerCase()) ?? 0;
    return {
      sku: row.sku,
      name: row.name,
      units: Math.round(row.units * 100) / 100,
      priorUnits,
      revenue: Math.round(row.revenue),
      currency: period.currency,
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
        period.currency,
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
      columnTotals: {
        units: Math.round(rows.reduce((s, r) => s + Number(r.units ?? 0), 0) * 100) / 100,
        priorUnits:
          Math.round(
            rows.reduce((s, r) => s + Number(r.priorUnits ?? 0), 0) * 100,
          ) / 100,
        revenue: Math.round(
          rows.reduce((s, r) => s + Number(r.revenue ?? 0), 0),
        ),
      },
    },
  };
}




export async function buildStockExpiryReport(
  db: TenantScopedPrisma,
  tenantId?: string,
): Promise<ReportsDashboard> {
  // Prefer SQL expand when tenantId is known; otherwise lean Prisma take.
  if (tenantId) {
    const rows = await db.$queryRaw<
      Array<{
        movement_id: string;
        sku: string;
        name: string;
        reference: string;
        location_code: string | null;
        exp_date: string | null;
      }>
    >`
      SELECT
        sm.id AS movement_id,
        COALESCE(elem->>'sku', '—') AS sku,
        COALESCE(elem->>'name', elem->>'sku', '—') AS name,
        sm.reference,
        sm."locationCode" AS location_code,
        NULLIF(elem->>'expDate', '') AS exp_date
      FROM "StockMovement" sm
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(sm.lines::jsonb) = 'array' THEN sm.lines::jsonb
          ELSE '[]'::jsonb
        END
      ) AS elem
      WHERE sm."tenantId" = ${tenantId}
        AND sm."deletedAt" IS NULL
        AND sm.type::text = 'inbound'
        AND sm.status::text = 'Received'
      ORDER BY sm.date DESC
      LIMIT 200
    `;

    return {
      kpis: [
        countKpi('Inbound lines', 'lines', rows.length, '#2563eb', 'package'),
      ],
      charts: [],
      table: {
        columns: [
          { key: 'sku', header: 'SKU' },
          { key: 'name', header: 'Product' },
          { key: 'reference', header: 'Purchase Ref' },
          { key: 'locationCode', header: 'Location' },
          { key: 'expDate', header: 'Expiry Date' },
        ],
        rows: rows.map((row) => ({
          id: `${row.movement_id}-${row.sku}`,
          sku: row.sku,
          name: row.name,
          reference: row.reference,
          locationCode: row.location_code ?? '—',
          expDate: row.exp_date ?? '—',
          actions: [
            {
              kind: 'edit-expiry' as const,
              label: 'Edit expiry',
              payload: {
                movementId: row.movement_id,
                lineSku: row.sku,
                expDate: row.exp_date ?? '',
              },
            },
          ],
        })),
      },
    };
  }

  const movements = await db.stockMovement.findMany({
    where: {
      deletedAt: null,
      type: 'inbound',
      status: 'Received',
    },
    select: {
      id: true,
      reference: true,
      locationCode: true,
      lines: true,
      date: true,
    },
    orderBy: { date: 'desc' },
    take: 100,
  });

  const rows: ReportsTableRow[] = [];

  for (const movement of movements) {
    const lines = parseMovementLines(movement.lines);
    for (const line of lines) {
      rows.push({
        id: `${movement.id}-${line.sku}`,
        sku: line.sku,
        name: line.name,
        reference: movement.reference,
        locationCode: movement.locationCode ?? '—',
        expDate: line.expDate ?? '—',
        actions: [
          {
            kind: 'edit-expiry',
            label: 'Edit expiry',
            payload: {
              movementId: movement.id,
              lineSku: line.sku,
              expDate: line.expDate ?? '',
            },
          },
        ],
      });
    }
  }

  return {
    kpis: [
      countKpi(
        'Inbound lines',
        'lines',
        rows.length,
        '#2563eb',
        'package',
      ),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'sku', header: 'SKU' },
        { key: 'name', header: 'Product' },
        { key: 'reference', header: 'Purchase Ref' },
        { key: 'locationCode', header: 'Location' },
        { key: 'expDate', header: 'Expiry Date' },
      ],
      rows: rows.slice(0, 200),
    },
  };
}

/** HQ6 product stock details — location qty vs item total with Fix action. */
export async function buildStockDetailsReport(
  db: TenantScopedPrisma,
): Promise<ReportsDashboard> {
  // Explicit select avoids requiring newer Item columns (subCategory, carModel, …).
  const items = await db.item.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      sku: true,
      name: true,
      quantity: true,
      locationCode: true,
      binLocation: true,
      locationStock: {
        select: {
          id: true,
          locationCode: true,
          binLocation: true,
          quantity: true,
        },
      },
    },
    orderBy: { sku: 'asc' },
    take: 500,
  });

  const rows: NonNullable<ReportsDashboard['table']>['rows'] = [];

  for (const item of items) {
    const locationSum = item.locationStock.reduce(
      (sum, row) => sum + row.quantity,
      0,
    );
    if (locationSum === item.quantity && item.locationStock.length > 0) {
      continue;
    }

    if (item.locationStock.length === 0) {
      rows.push({
        id: item.id,
        sku: item.sku,
        name: item.name,
        locationCode: item.locationCode ?? '—',
        locationQty: 0,
        itemTotal: item.quantity,
        calculatedTotal: locationSum,
        actions: [
          {
            kind: 'fix-stock',
            label: 'Fix',
            payload: {
              itemId: item.id,
              locationCode: item.locationCode ?? 'MAIN',
              binLocation: item.binLocation ?? '',
              quantity: item.quantity,
            },
          },
        ],
      });
      continue;
    }

    for (const loc of item.locationStock) {
      rows.push({
        id: `${item.id}-${loc.id}`,
        sku: item.sku,
        name: item.name,
        locationCode: loc.locationCode,
        binLocation: loc.binLocation || '—',
        locationQty: loc.quantity,
        itemTotal: item.quantity,
        calculatedTotal: locationSum,
        actions: [
          {
            kind: 'fix-stock',
            label: 'Fix',
            payload: {
              itemId: item.id,
              locationCode: loc.locationCode,
              binLocation: loc.binLocation,
              quantity: loc.quantity,
            },
          },
        ],
      });
    }
  }

  return {
    kpis: [
      countKpi(
        'Mismatch rows',
        'mismatches',
        rows.length,
        '#e11d48',
        'alert-triangle',
      ),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'sku', header: 'SKU' },
        { key: 'name', header: 'Product' },
        { key: 'locationCode', header: 'Location' },
        { key: 'binLocation', header: 'Bin' },
        { key: 'locationQty', header: 'Location Qty' },
        { key: 'itemTotal', header: 'Item Total' },
        { key: 'calculatedTotal', header: 'Sum of Locations' },
      ],
      rows: rows.slice(0, 200),
    },
  };
}

/** Service staff report — SQL group by assigned employee / cleaner. */
export async function buildServiceStaffReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const byStaff = await salesByServiceStaff(db, tenantId, window);
  const currency = byStaff[0]?.currency ?? 'NGN';

  const rows: ReportsTableRow[] = byStaff.map((row) => ({
    staff: row.staff,
    transactions: row.count,
    revenue: Math.round(row.revenue),
    avgTicket: row.count > 0 ? Math.round(row.revenue / row.count) : 0,
    currency,
  }));

  const totalRevenue = rows.reduce((sum, r) => sum + Number(r.revenue ?? 0), 0);
  const totalTx = byStaff.reduce((sum, row) => sum + row.count, 0);

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
      countKpi('Service Staff', 'staff', rows.length, '#2563eb', 'users'),
      countKpi('Transactions', 'transactions', totalTx, '#9333ea', 'receipt'),
      currencyKpi(
        'Top Ticket',
        'topTicket',
        rows[0]?.revenue != null ? Number(rows[0].revenue) : 0,
        currency,
        '#e11d48',
        'trending-up',
      ),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'staff', header: 'Service Staff' },
        { key: 'transactions', header: 'Orders', totalAs: 'number' },
        { key: 'revenue', header: 'Revenue', totalAs: 'currency' },
        { key: 'avgTicket', header: 'Avg Ticket', totalAs: 'currency' },
      ],
      rows,
    },
  };
}
