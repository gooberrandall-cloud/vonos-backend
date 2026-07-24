import type { ReportsChart, ReportsKpi } from '@vonos/types';
import type { TenantScopedPrisma } from '../../common/prisma/prisma.service';
import {
  computeDelta,
  priorWindow,
  resolveDateWindow,
  asChartData,
} from '../reports/aggregators/date-utils';
export interface LedgerFinanceSlice {
  currency: string;
  financeCharts: ReportsChart[];
  financeKpis: ReportsKpi[];
}

export async function buildLedgerFinanceSlice(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<LedgerFinanceSlice> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);
  const earliest =
    prior.from.getTime() <= window.from.getTime() ? prior.from : window.from;
  const latest =
    prior.to.getTime() >= window.to.getTime() ? prior.to : window.to;

  // Try rollup first (no separate probe RTT). Fall back to live ledger if empty.
  const rollupRows = await db.$queryRaw<
    Array<{
      cur_revenue: unknown;
      cur_costs: unknown;
      cur_expenses: unknown;
      cur_net: unknown;
      prior_revenue: unknown;
      prior_costs: unknown;
      prior_expenses: unknown;
      prior_net: unknown;
      trend: unknown;
      row_count: unknown;
    }>
  >`
    WITH daily AS (
      SELECT date, revenue, costs, expenses, net
      FROM "TenantDailyFinance"
      WHERE "tenantId" = ${tenantId}
        AND date >= ${earliest}
        AND date <= ${latest}
    )
    SELECT
      COALESCE(SUM(revenue) FILTER (
        WHERE date >= ${window.from} AND date <= ${window.to}
      ), 0) AS cur_revenue,
      COALESCE(SUM(costs) FILTER (
        WHERE date >= ${window.from} AND date <= ${window.to}
      ), 0) AS cur_costs,
      COALESCE(SUM(expenses) FILTER (
        WHERE date >= ${window.from} AND date <= ${window.to}
      ), 0) AS cur_expenses,
      COALESCE(SUM(net) FILTER (
        WHERE date >= ${window.from} AND date <= ${window.to}
      ), 0) AS cur_net,
      COALESCE(SUM(revenue) FILTER (
        WHERE date >= ${prior.from} AND date <= ${prior.to}
      ), 0) AS prior_revenue,
      COALESCE(SUM(costs) FILTER (
        WHERE date >= ${prior.from} AND date <= ${prior.to}
      ), 0) AS prior_costs,
      COALESCE(SUM(expenses) FILTER (
        WHERE date >= ${prior.from} AND date <= ${prior.to}
      ), 0) AS prior_expenses,
      COALESCE(SUM(net) FILTER (
        WHERE date >= ${prior.from} AND date <= ${prior.to}
      ), 0) AS prior_net,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'label', to_char(date, 'YYYY-MM-DD'),
              'revenue', revenue,
              'costs', costs + expenses
            )
            ORDER BY date ASC
          )
          FROM daily
          WHERE date >= ${window.from} AND date <= ${window.to}
        ),
        '[]'::json
      ) AS trend,
      (SELECT COUNT(*)::int FROM daily) AS row_count
    FROM daily
  `;

  const rollupRow = rollupRows[0];
  if (Number(rollupRow?.row_count ?? 0) > 0) {
    const summary = {
      revenue: Number(rollupRow?.cur_revenue ?? 0),
      costs: Number(rollupRow?.cur_costs ?? 0),
      expenses: Number(rollupRow?.cur_expenses ?? 0),
      net: Number(rollupRow?.cur_net ?? 0),
    };
    const priorSummary = {
      revenue: Number(rollupRow?.prior_revenue ?? 0),
      costs: Number(rollupRow?.prior_costs ?? 0),
      expenses: Number(rollupRow?.prior_expenses ?? 0),
      net: Number(rollupRow?.prior_net ?? 0),
    };
    const costs = summary.costs + summary.expenses;
    const priorCosts = priorSummary.costs + priorSummary.expenses;
    const currency = 'NGN';
    const expenseBreakdown = [
      { label: 'Costs', value: summary.costs },
      { label: 'Expenses', value: summary.expenses },
    ].filter((entry) => entry.value > 0);
    const trendRaw = Array.isArray(rollupRow?.trend)
      ? (rollupRow.trend as Array<{ label: string; revenue: number; costs: number }>)
      : typeof rollupRow?.trend === 'string'
        ? (JSON.parse(rollupRow.trend) as Array<{
            label: string;
            revenue: number;
            costs: number;
          }>)
        : [];
    const plTrend =
      trendRaw.length > 0
        ? trendRaw.map((t) => ({
            label: t.label,
            revenue: Number(t.revenue),
            costs: Number(t.costs),
          }))
        : [{ label: '—', revenue: 0, costs: 0 }];

    return {
      currency,
      financeCharts: financeCharts(
        bucketTrend(plTrend, window),
        expenseBreakdown.length > 0
          ? expenseBreakdown
          : [{ label: '—', value: 0 }],
      ),
      financeKpis: financeKpis(
        {
          revenue: summary.revenue,
          costs,
          net: summary.net,
        },
        {
          revenue: priorSummary.revenue,
          costs: priorCosts,
          net: priorSummary.net,
        },
        currency,
      ),
    };
  }

  // Ledger path: one FILTER query for summaries + currency; one for trend+categories.
  const [summaryRow, detailRows] = await Promise.all([
    db.$queryRaw<
      Array<{
        revenue: unknown;
        costs: unknown;
        prior_revenue: unknown;
        prior_costs: unknown;
        currency: string | null;
      }>
    >`
      SELECT
        COALESCE(SUM(amount) FILTER (
          WHERE type = 'revenue'
            AND date >= ${window.from}
            AND date <= ${window.to}
        ), 0) AS revenue,
        COALESCE(SUM(amount) FILTER (
          WHERE type <> 'revenue'
            AND date >= ${window.from}
            AND date <= ${window.to}
        ), 0) AS costs,
        COALESCE(SUM(amount) FILTER (
          WHERE type = 'revenue'
            AND date >= ${prior.from}
            AND date <= ${prior.to}
        ), 0) AS prior_revenue,
        COALESCE(SUM(amount) FILTER (
          WHERE type <> 'revenue'
            AND date >= ${prior.from}
            AND date <= ${prior.to}
        ), 0) AS prior_costs,
        (
          SELECT currency
          FROM "LedgerEntry"
          WHERE "tenantId" = ${tenantId}
            AND "deletedAt" IS NULL
          ORDER BY id ASC
          LIMIT 1
        ) AS currency
      FROM "LedgerEntry"
      WHERE "tenantId" = ${tenantId}
        AND "deletedAt" IS NULL
        AND date >= ${earliest}
        AND date <= ${latest}
    `,
    db.$queryRaw<
      Array<{
        pl_trend: unknown;
        expense_breakdown: unknown;
      }>
    >`
      WITH windowed AS (
        SELECT date, type, category, amount
        FROM "LedgerEntry"
        WHERE "tenantId" = ${tenantId}
          AND "deletedAt" IS NULL
          AND date >= ${window.from}
          AND date <= ${window.to}
      )
      SELECT
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'label', label,
                'revenue', revenue,
                'costs', costs
              )
              ORDER BY label ASC
            )
            FROM (
              SELECT
                to_char(date_trunc('day', date), 'YYYY-MM-DD') AS label,
                COALESCE(SUM(amount) FILTER (WHERE type = 'revenue'), 0) AS revenue,
                COALESCE(SUM(amount) FILTER (WHERE type <> 'revenue'), 0) AS costs
              FROM windowed
              GROUP BY 1
            ) t
          ),
          '[]'::json
        ) AS pl_trend,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object('label', category, 'value', total)
              ORDER BY total DESC
            )
            FROM (
              SELECT category, COALESCE(SUM(amount), 0) AS total
              FROM windowed
              WHERE type <> 'revenue'
              GROUP BY category
              ORDER BY total DESC
              LIMIT 8
            ) e
          ),
          '[]'::json
        ) AS expense_breakdown
    `,
  ]);

  const summary = summaryRow[0];
  const details = detailRows[0];
  const currency = summary?.currency ?? 'NGN';
  const plTrendRaw = Array.isArray(details?.pl_trend)
    ? (details.pl_trend as Array<{ label: string; revenue: number; costs: number }>)
    : typeof details?.pl_trend === 'string'
      ? (JSON.parse(details.pl_trend) as Array<{
          label: string;
          revenue: number;
          costs: number;
        }>)
      : [];
  const expenseRaw = Array.isArray(details?.expense_breakdown)
    ? (details.expense_breakdown as Array<{ label: string; value: number }>)
    : typeof details?.expense_breakdown === 'string'
      ? (JSON.parse(details.expense_breakdown) as Array<{
          label: string;
          value: number;
        }>)
      : [];

  const plTrend =
    plTrendRaw.length > 0
      ? plTrendRaw.map((t) => ({
          label: t.label,
          revenue: Number(t.revenue),
          costs: Number(t.costs),
        }))
      : [{ label: '—', revenue: 0, costs: 0 }];
  const expenseBreakdown =
    expenseRaw.length > 0
      ? expenseRaw.map((e) => ({ label: e.label, value: Number(e.value) }))
      : [{ label: '—', value: 0 }];

  return {
    currency,
    financeCharts: financeCharts(bucketTrend(plTrend, window), expenseBreakdown),
    financeKpis: financeKpis(
      {
        revenue: Number(summary?.revenue ?? 0),
        costs: Number(summary?.costs ?? 0),
        net: Number(summary?.revenue ?? 0) - Number(summary?.costs ?? 0),
      },
      {
        revenue: Number(summary?.prior_revenue ?? 0),
        costs: Number(summary?.prior_costs ?? 0),
        net:
          Number(summary?.prior_revenue ?? 0) -
          Number(summary?.prior_costs ?? 0),
      },
      currency,
    ),
  };
}

/** Collapse daily rollup points to months when the window is long (keeps payload small). */
function bucketTrend(
  rows: Array<{ label: string; revenue: number; costs: number }>,
  window: { from: Date; to: Date },
): Array<{ label: string; revenue: number; costs: number }> {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  if (spanDays <= 60 || rows.length <= 60) return rows;

  const byMonth = new Map<string, { label: string; revenue: number; costs: number }>();
  for (const row of rows) {
    const month = row.label.slice(0, 7); // YYYY-MM
    const existing = byMonth.get(month) ?? {
      label: month,
      revenue: 0,
      costs: 0,
    };
    existing.revenue += row.revenue;
    existing.costs += row.costs;
    byMonth.set(month, existing);
  }
  return Array.from(byMonth.values());
}

function financeCharts(
  plTrend: Array<{ label: string; revenue: number; costs: number }>,
  expenseBreakdown: Array<{ label: string; value: number }>,
): ReportsChart[] {
  return [
    {
      id: 'finance-pl-trend',
      title: 'Revenue vs Costs',
      subtitle: 'Ledger totals for selected period',
      type: 'line',
      series: [
        { name: 'Revenue', dataKey: 'revenue', color: '#059669' },
        { name: 'Costs', dataKey: 'costs', color: '#e11d48' },
      ],
      data: asChartData(plTrend),
    },
    {
      id: 'finance-expense-breakdown',
      title: 'Costs & Expenses by Category',
      subtitle: 'Non-revenue ledger entries',
      type: 'pie',
      series: [{ name: 'Amount', dataKey: 'value', color: '#9333ea' }],
      data: asChartData(expenseBreakdown),
    },
  ];
}

/** HQ6 Home stat cards — ui-audit/00_home/screenshot.png (VA only). */
function num(value: unknown): number {
  return Number(value ?? 0);
}

function last30DayWindow(): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export interface VaHq6HomeBundle {
  currency: string;
  revenue: number;
  financeKpis: ReportsKpi[];
  charts: ReportsChart[];
}

/**
 * VA HQ6 home — one SQL round trip for finance KPIs + last-30-day charts.
 * Uses Sale / Invoice totals (indexed) instead of StockMovement JSON line scans.
 */
export async function buildVaHq6HomeBundle(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<VaHq6HomeBundle> {
  const kpiWindow = resolveDateWindow(from, to);
  const chartWindow = last30DayWindow();

  const rows = await db.$queryRaw<
    Array<{
      currency: string | null;
      ledger_costs: unknown;
      ledger_revenue: unknown;
      total_sale: unknown;
      sale_due: unknown;
      sell_return: unknown;
      total_purchase: unknown;
      purchase_due: unknown;
      purchase_return: unknown;
      sales_trend: unknown;
      purchase_trend: unknown;
    }>
  >`
    SELECT
      (
        SELECT currency FROM "Sale"
        WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
        ORDER BY id ASC LIMIT 1
      ) AS currency,
      COALESCE((
        SELECT SUM(amount) FILTER (WHERE type <> 'revenue')
        FROM "LedgerEntry"
        WHERE "tenantId" = ${tenantId}
          AND "deletedAt" IS NULL
          AND date >= ${kpiWindow.from}
          AND date <= ${kpiWindow.to}
      ), 0) AS ledger_costs,
      COALESCE((
        SELECT SUM(amount) FILTER (WHERE type = 'revenue')
        FROM "LedgerEntry"
        WHERE "tenantId" = ${tenantId}
          AND "deletedAt" IS NULL
          AND date >= ${kpiWindow.from}
          AND date <= ${kpiWindow.to}
      ), 0) AS ledger_revenue,
      COALESCE((
        SELECT SUM(s.total)
        FROM "Sale" s
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text NOT IN (
            'draft', 'quotation', 'refunded', 'partially_refunded', 'written_off'
          )
          AND s.date >= ${kpiWindow.from}
          AND s.date <= ${kpiWindow.to}
      ), 0) AS total_sale,
      COALESCE((
        SELECT SUM(GREATEST(0, s.total - COALESCE(p.paid, 0)))
        FROM "Sale" s
        LEFT JOIN (
          SELECT "saleId", SUM(amount) AS paid
          FROM "Payment"
          WHERE "deletedAt" IS NULL
          GROUP BY "saleId"
        ) p ON p."saleId" = s.id
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text <> 'draft'
          AND s."paymentStatus"::text IN ('due', 'partial', 'overdue')
          AND s.date >= ${kpiWindow.from}
          AND s.date <= ${kpiWindow.to}
      ), 0) AS sale_due,
      COALESCE((
        SELECT SUM(s.total)
        FROM "Sale" s
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text IN (
            'refunded', 'partially_refunded', 'written_off'
          )
          AND s.date >= ${kpiWindow.from}
          AND s.date <= ${kpiWindow.to}
      ), 0) AS sell_return,
      COALESCE((
        SELECT SUM(i.total)
        FROM "Invoice" i
        INNER JOIN "StockMovement" sm ON sm.id = i."stockMovementId"
        WHERE i."tenantId" = ${tenantId}
          AND i."deletedAt" IS NULL
          AND i.kind = 'purchase'
          AND sm."deletedAt" IS NULL
          AND sm.source::text = 'standard'
          AND i."documentDate" >= ${kpiWindow.from}
          AND i."documentDate" <= ${kpiWindow.to}
      ), 0) AS total_purchase,
      COALESCE((
        SELECT SUM(i.total)
        FROM "Invoice" i
        INNER JOIN "StockMovement" sm ON sm.id = i."stockMovementId"
        WHERE i."tenantId" = ${tenantId}
          AND i."deletedAt" IS NULL
          AND i.kind = 'purchase'
          AND sm."deletedAt" IS NULL
          AND sm.source::text = 'standard'
          AND COALESCE(i."paymentStatus", sm."paymentStatus"::text)
            IN ('due', 'partial', 'overdue')
          AND i."documentDate" >= ${kpiWindow.from}
          AND i."documentDate" <= ${kpiWindow.to}
      ), 0) AS purchase_due,
      COALESCE((
        SELECT SUM(i.total)
        FROM "Invoice" i
        INNER JOIN "StockMovement" sm ON sm.id = i."stockMovementId"
        WHERE i."tenantId" = ${tenantId}
          AND i."deletedAt" IS NULL
          AND i.kind = 'purchase'
          AND sm."deletedAt" IS NULL
          AND sm.source::text = 'purchase_return'
          AND i."documentDate" >= ${kpiWindow.from}
          AND i."documentDate" <= ${kpiWindow.to}
      ), 0) AS purchase_return,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'label', to_char(bucket, 'Mon DD'),
              'sales', sales
            )
            ORDER BY bucket ASC
          )
          FROM (
            SELECT date_trunc('day', date) AS bucket, COALESCE(SUM(total), 0) AS sales
            FROM "Sale"
            WHERE "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
              AND status::text <> 'draft'
              AND date >= ${chartWindow.from}
              AND date <= ${chartWindow.to}
            GROUP BY 1
          ) s
        ),
        '[]'::json
      ) AS sales_trend,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'label', to_char(bucket, 'Mon DD'),
              'purchase', purchase
            )
            ORDER BY bucket ASC
          )
          FROM (
            SELECT date_trunc('day', i."documentDate") AS bucket,
              COALESCE(SUM(i.total), 0) AS purchase
            FROM "Invoice" i
            INNER JOIN "StockMovement" sm ON sm.id = i."stockMovementId"
            WHERE i."tenantId" = ${tenantId}
              AND i."deletedAt" IS NULL
              AND i.kind = 'purchase'
              AND sm."deletedAt" IS NULL
              AND sm.source::text = 'standard'
              AND i."documentDate" >= ${chartWindow.from}
              AND i."documentDate" <= ${chartWindow.to}
            GROUP BY 1
          ) p
        ),
        '[]'::json
      ) AS purchase_trend
  `;

  const row = rows[0];
  const currency = row?.currency ?? 'NGN';
  const expenseTotal = num(row?.ledger_costs);
  const revenue = num(row?.ledger_revenue);
  const salesRaw = parseJsonArray<{ label: string; sales: number }>(
    row?.sales_trend,
  );
  const purchaseRaw = parseJsonArray<{ label: string; purchase: number }>(
    row?.purchase_trend,
  );

  return {
    currency,
    revenue,
    financeKpis: [
      {
        label: 'Total Sales',
        icon: 'wallet',
        metricKey: 'totalSale',
        color: '#3b82f6',
        value: num(row?.total_sale),
        currency,
      },
      {
        label: 'Net',
        icon: 'wallet',
        metricKey: 'net',
        color: '#9333ea',
        value: revenue - expenseTotal,
        currency,
      },
      {
        label: 'Invoice due',
        icon: 'alert',
        metricKey: 'invoiceDue',
        color: '#f39c12',
        value: num(row?.sale_due),
        currency,
      },
      {
        label: 'Total Sell Return',
        icon: 'rotate',
        metricKey: 'sellReturn',
        color: '#dd4b39',
        value: num(row?.sell_return),
        currency,
      },
      {
        label: 'Total purchase',
        icon: 'cart',
        metricKey: 'purchase',
        color: '#00a65a',
        value: num(row?.total_purchase),
        currency,
      },
      {
        label: 'Purchase due',
        icon: 'alert',
        metricKey: 'purchaseDue',
        color: '#f39c12',
        value: num(row?.purchase_due),
        currency,
      },
      {
        label: 'Total Purchase Return',
        icon: 'package',
        metricKey: 'purchaseReturn',
        color: '#605ca8',
        value: num(row?.purchase_return),
        currency,
      },
      {
        label: 'Expense',
        icon: 'receipt',
        metricKey: 'expense',
        color: '#2563eb',
        value: expenseTotal,
        currency,
      },
    ],
    charts: [
      {
        id: 'hq6-sales-last-30',
        title: 'Sales Last 30 Days',
        subtitle: 'Total sales value',
        type: 'line',
        series: [{ name: 'Total Sales', dataKey: 'sales', color: '#3b82f6' }],
        data: asChartData(
          salesRaw.map((r) => ({ label: r.label, sales: Number(r.sales) })),
        ),
      },
      {
        id: 'hq6-purchase-last-30',
        title: 'Purchase Last 30 Days',
        subtitle: 'Total purchase value',
        type: 'line',
        series: [
          { name: 'Total Purchase', dataKey: 'purchase', color: '#00a65a' },
        ],
        data: asChartData(
          purchaseRaw.map((r) => ({
            label: r.label,
            purchase: Number(r.purchase),
          })),
        ),
      },
    ],
  };
}

/** @deprecated Prefer buildVaHq6HomeBundle — kept for any external callers. */
export async function buildVaHq6HomeFinanceKpis(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<ReportsKpi[]> {
  const bundle = await buildVaHq6HomeBundle(db, tenantId, from, to);
  return bundle.financeKpis;
}

/** @deprecated Prefer buildVaHq6HomeBundle — kept for any external callers. */
export async function buildVaHq6HomeCharts(
  db: TenantScopedPrisma,
  tenantId: string,
): Promise<ReportsChart[]> {
  const bundle = await buildVaHq6HomeBundle(db, tenantId);
  return bundle.charts;
}

function financeKpis(
  summary: { revenue: number; costs: number; net: number },
  priorSummary: { revenue: number; costs: number; net: number },
  currency: string,
): ReportsKpi[] {
  return [
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
}
