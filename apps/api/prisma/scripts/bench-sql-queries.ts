/**
 * Full raw-SQL timing suite for Chion speed work (branch: chion/sql-speed-bench).
 *
 * Runs EXPLAIN (ANALYZE, BUFFERS) + wall-clock SELECT for representative
 * Vonos analytics / list / finance queries against VA (and multi-tenant where needed).
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/bench-sql-queries.ts
 *
 * Writes:
 *   docs/migration-audits/SQL_BENCH_RESULTS.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const VA = 'tenant_va_001';
const VW = 'tenant_vw_001';
const TENANTS = [VA, VW, 'tenant_visp_001', 'tenant_vsp_001', 'tenant_vp_001'];

function loadDatabaseUrls(): string[] {
  const envPath = join(__dirname, '../../.env');
  const env = readFileSync(envPath, 'utf8');
  const raw = env
    .match(/^DATABASE_URL=(.+)$/m)?.[1]
    ?.replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('DATABASE_URL not found in apps/api/.env');

  const withParams = (url: string) => {
    const sep = url.includes('?') ? '&' : '?';
    const hasSsl = /sslmode=/.test(url);
    return `${url}${sep}connection_limit=1&pool_timeout=60${hasSsl ? '' : '&sslmode=require'}`;
  };

  const direct = raw.replace('-pooler.', '.');
  return [...new Set([withParams(direct), withParams(raw)])];
}

async function connect(): Promise<PrismaClient> {
  for (const url of loadDatabaseUrls()) {
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      return prisma;
    } catch {
      await prisma.$disconnect().catch(() => undefined);
    }
  }
  throw new Error('Could not connect via direct or pooler DATABASE_URL');
}

type BenchRow = {
  id: string;
  group: string;
  window: '30d' | '365d' | 'list' | 'snapshot' | 'today';
  explainMs: number;
  planMs: number;
  wallMs: number;
  rows: number;
  seqScan: boolean;
  indexes: string[];
  error?: string;
};

function iso(d: Date): string {
  return d.toISOString();
}

function windows() {
  const to = new Date();
  const d30 = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const d365 = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
  const priorTo = new Date(d30);
  const priorFrom = new Date(d30.getTime() - 30 * 24 * 60 * 60 * 1000);
  const todayStart = new Date(to);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(to);
  todayEnd.setUTCHours(23, 59, 59, 999);
  return { to, d30, d365, priorFrom, priorTo, todayStart, todayEnd };
}

function summarizePlan(planText: string): {
  explainMs: number;
  planMs: number;
  seqScan: boolean;
  indexes: string[];
} {
  const explainMs = Number(
    planText.match(/Execution Time:\s*([\d.]+)/)?.[1] ?? 0,
  );
  const planMs = Number(planText.match(/Planning Time:\s*([\d.]+)/)?.[1] ?? 0);
  const seqScan = /Seq Scan on/.test(planText);
  const indexes = [
    ...new Set(
      [...planText.matchAll(/using "?([^"\s]+)"?/gi)].map((m) => m[1] ?? ''),
    ),
  ].filter(Boolean);
  return { explainMs, planMs, seqScan, indexes: indexes.slice(0, 10) };
}

async function benchOne(
  prisma: PrismaClient,
  id: string,
  group: string,
  window: BenchRow['window'],
  sql: string,
): Promise<BenchRow> {
  try {
    const explainRows = await prisma.$queryRawUnsafe<
      Array<{ 'QUERY PLAN': string }>
    >(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`);
    const planText = explainRows.map((r) => r['QUERY PLAN']).join('\n');
    const summary = summarizePlan(planText);

    const t0 = performance.now();
    const result = await prisma.$queryRawUnsafe<unknown[]>(sql);
    const wallMs = Math.round((performance.now() - t0) * 100) / 100;
    const rows = Array.isArray(result) ? result.length : 0;

    return {
      id,
      group,
      window,
      explainMs: summary.explainMs,
      planMs: summary.planMs,
      wallMs,
      rows,
      seqScan: summary.seqScan,
      indexes: summary.indexes,
    };
  } catch (e) {
    return {
      id,
      group,
      window,
      explainMs: 0,
      planMs: 0,
      wallMs: 0,
      rows: 0,
      seqScan: false,
      indexes: [],
      error: e instanceof Error ? e.message.slice(0, 240) : String(e),
    };
  }
}

function buildCatalog(): Array<{
  id: string;
  group: string;
  window: BenchRow['window'];
  sql: string;
}> {
  const { to, d30, d365, priorFrom, priorTo, todayStart, todayEnd } = windows();
  const f30 = iso(d30);
  const t = iso(to);
  const f365 = iso(d365);
  const pf = iso(priorFrom);
  const pt = iso(priorTo);
  const ts = iso(todayStart);
  const te = iso(todayEnd);
  const tenantList = TENANTS.map((x) => `'${x}'`).join(',');

  const cashBook = `AND category NOT IN ('Customer Payment', 'Supplier Payment')`;

  const q: Array<{
    id: string;
    group: string;
    window: BenchRow['window'];
    sql: string;
  }> = [];

  const add = (
    id: string,
    group: string,
    window: BenchRow['window'],
    sql: string,
  ) => q.push({ id, group, window, sql });

  // --- Lists (hot path) ---
  add(
    'list.customers',
    'list',
    'list',
    `SELECT c.id, c.name FROM "Customer" c
     WHERE c."tenantId"='${VA}' AND c."deletedAt" IS NULL
     ORDER BY c.name ASC, c.id ASC LIMIT 26`,
  );
  add(
    'list.sales',
    'list',
    'list',
    `SELECT s.id FROM "Sale" s
     WHERE s."tenantId"='${VA}' AND s."deletedAt" IS NULL
     ORDER BY s.date DESC, s.id DESC LIMIT 26`,
  );
  add(
    'list.jobs',
    'list',
    'list',
    `SELECT j.id, j.reference FROM "Job" j
     WHERE j."tenantId"='${VA}' AND j."deletedAt" IS NULL
     ORDER BY j."createdAt" DESC, j.id DESC LIMIT 26`,
  );
  add(
    'list.items',
    'list',
    'list',
    `SELECT i.id, i.name FROM "Item" i
     WHERE i."tenantId"='${VA}' AND i."deletedAt" IS NULL
     ORDER BY i."updatedAt" DESC, i.id DESC LIMIT 26`,
  );
  add(
    'list.ledger',
    'list',
    'list',
    `SELECT l.id FROM "LedgerEntry" l
     WHERE l."tenantId"='${VA}' AND l."deletedAt" IS NULL
     ORDER BY l.date DESC, l.id DESC LIMIT 26`,
  );
  add(
    'list.expenses',
    'list',
    'list',
    `SELECT e.id FROM "Expense" e
     WHERE e."tenantId"='${VA}' AND e."deletedAt" IS NULL
     ORDER BY e."expenseDate" DESC, e.id DESC LIMIT 26`,
  );
  add(
    'list.payments',
    'list',
    'list',
    `SELECT p.id FROM "Payment" p
     WHERE p."tenantId"='${VA}' AND p."deletedAt" IS NULL
     ORDER BY p."createdAt" DESC, p.id DESC LIMIT 26`,
  );
  add(
    'list.movements',
    'list',
    'list',
    `SELECT m.id FROM "StockMovement" m
     WHERE m."tenantId"='${VA}' AND m."deletedAt" IS NULL
     ORDER BY m.date DESC, m.id DESC LIMIT 26`,
  );
  add(
    'list.invoices',
    'list',
    'list',
    `SELECT i.id, i.reference FROM "Invoice" i
     WHERE i."tenantId"='${VA}' AND i."deletedAt" IS NULL
     ORDER BY i."documentDate" DESC, i.id DESC LIMIT 26`,
  );
  add(
    'list.customers.search',
    'list',
    'list',
    `SELECT c.id FROM "Customer" c
     WHERE c."tenantId"='${VA}' AND c."deletedAt" IS NULL
       AND (c.name ILIKE '%a%' OR c.email ILIKE '%a%' OR c.phone ILIKE '%a%')
     ORDER BY c.name ASC, c.id ASC LIMIT 26`,
  );
  add(
    'list.items.search',
    'list',
    'list',
    `SELECT i.id FROM "Item" i
     WHERE i."tenantId"='${VA}' AND i."deletedAt" IS NULL
       AND (i.name ILIKE '%brake%' OR i.sku ILIKE '%brake%' OR i."carModel" ILIKE '%brake%')
     ORDER BY i."updatedAt" DESC, i.id DESC LIMIT 26`,
  );

  // --- Sales reports ---
  for (const [wlabel, from] of [
    ['30d', f30],
    ['365d', f365],
  ] as const) {
    add(
      `sales.revenueTrend.${wlabel}`,
      'sales',
      wlabel,
      `SELECT date_trunc('day', date) AS bucket, COALESCE(SUM(total), 0) AS revenue
       FROM "Sale"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND status::text <> 'draft'
         AND date >= '${from}' AND date <= '${t}'
       GROUP BY bucket ORDER BY bucket ASC`,
    );
    add(
      `sales.orderTrend.${wlabel}`,
      'sales',
      wlabel,
      `SELECT date_trunc('day', date) AS bucket, COUNT(*)::bigint AS orders
       FROM "Sale"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND status::text <> 'draft'
         AND date >= '${from}' AND date <= '${t}'
       GROUP BY bucket ORDER BY bucket ASC`,
    );
    add(
      `sales.paymentStatus.${wlabel}`,
      'sales',
      wlabel,
      `SELECT "paymentStatus"::text AS label, COUNT(*)::bigint AS value
       FROM "Sale"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND status::text <> 'draft'
         AND date >= '${from}' AND date <= '${t}'
       GROUP BY 1 ORDER BY value DESC`,
    );
    add(
      `sales.byDay.${wlabel}`,
      'sales',
      wlabel,
      `SELECT date_trunc('day', date) AS day, COUNT(*)::bigint AS count, COALESCE(SUM(total),0) AS revenue
       FROM "Sale"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND status::text <> 'draft'
         AND date >= '${from}' AND date <= '${t}'
       GROUP BY 1 ORDER BY 1`,
    );
    add(
      `sales.byCreatedBy.${wlabel}`,
      'sales',
      wlabel,
      `SELECT COALESCE("createdByName", 'Unknown') AS staff, COUNT(*)::bigint AS count,
              COALESCE(SUM(total),0) AS revenue, MIN(currency) AS currency
       FROM "Sale"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND status::text <> 'draft'
         AND date >= '${from}' AND date <= '${t}'
       GROUP BY 1 ORDER BY revenue DESC LIMIT 50`,
    );
    add(
      `sales.topProducts.${wlabel}`,
      'sales',
      wlabel,
      `SELECT MAX(COALESCE(NULLIF(TRIM(sl.sku), ''), sl.name)) AS sku,
              COALESCE(SUM(sl.quantity), 0) AS qty,
              COALESCE(SUM(sl."lineTotal"), 0) AS revenue
       FROM "SaleLine" sl
       INNER JOIN "Sale" s ON s.id = sl."saleId"
       WHERE s."tenantId" = '${VA}' AND s."deletedAt" IS NULL
         AND s.status::text <> 'draft'
         AND s.date >= '${from}' AND s.date <= '${t}'
       GROUP BY LOWER(COALESCE(NULLIF(TRIM(sl.sku), ''), sl.name))
       ORDER BY revenue DESC LIMIT 12`,
    );
    add(
      `sales.hourlyOrders.${wlabel}`,
      'sales',
      wlabel,
      `SELECT EXTRACT(HOUR FROM date)::int AS hour, COUNT(*)::bigint AS orders
       FROM "Sale"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND status::text <> 'draft'
         AND date >= '${from}' AND date <= '${t}'
       GROUP BY 1 ORDER BY 1`,
    );
    add(
      `sales.sumWindow.${wlabel}`,
      'sales',
      wlabel,
      `SELECT COUNT(*)::bigint AS n, COALESCE(SUM(total),0) AS revenue
       FROM "Sale"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND status::text <> 'draft'
         AND date >= '${from}' AND date <= '${t}'`,
    );
  }

  // --- Purchase / inbound JSON ---
  add(
    'sales.purchaseRevenueByBucket.30d',
    'sales',
    '30d',
    `SELECT date_trunc('day', sm.date) AS bucket,
            COALESCE(SUM(
              COALESCE((elem->>'quantity')::numeric, 0)
              * COALESCE((elem->>'unitCost')::numeric, 0)
            ), 0) AS purchase
     FROM "StockMovement" sm,
          LATERAL jsonb_array_elements(COALESCE(sm.lines, '[]'::jsonb)) elem
     WHERE sm."tenantId" = '${VA}' AND sm."deletedAt" IS NULL
       AND sm.type::text = 'inbound'
       AND sm.date >= '${f30}' AND sm.date <= '${t}'
     GROUP BY 1 ORDER BY 1 ASC`,
  );

  // --- Ledger / finance ---
  for (const [wlabel, from] of [
    ['30d', f30],
    ['365d', f365],
  ] as const) {
    add(
      `ledger.summary.${wlabel}`,
      'ledger',
      wlabel,
      `SELECT type, COALESCE(SUM(amount), 0) AS total
       FROM "LedgerEntry"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND date >= '${from}' AND date <= '${t}'
         ${cashBook}
       GROUP BY type`,
    );
    add(
      `ledger.plTrend.${wlabel}`,
      'ledger',
      wlabel,
      `SELECT date_trunc('day', date) AS bucket, type, COALESCE(SUM(amount), 0) AS total
       FROM "LedgerEntry"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND date >= '${from}' AND date <= '${t}'
         ${cashBook}
       GROUP BY bucket, type ORDER BY bucket ASC`,
    );
    add(
      `ledger.expenseBreakdown.${wlabel}`,
      'ledger',
      wlabel,
      `SELECT category, COALESCE(SUM(amount), 0) AS total
       FROM "LedgerEntry"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND type <> 'revenue'
         AND date >= '${from}' AND date <= '${t}'
         ${cashBook}
       GROUP BY category ORDER BY total DESC LIMIT 12`,
    );
    add(
      `ledger.revenueBreakdown.${wlabel}`,
      'ledger',
      wlabel,
      `SELECT category, COALESCE(SUM(amount), 0) AS total
       FROM "LedgerEntry"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND type = 'revenue'
         AND date >= '${from}' AND date <= '${t}'
         ${cashBook}
       GROUP BY category ORDER BY total DESC LIMIT 12`,
    );
    add(
      `ledger.costByBucket.${wlabel}`,
      'ledger',
      wlabel,
      `SELECT date_trunc('day', date) AS bucket, COALESCE(SUM(amount), 0) AS purchases
       FROM "LedgerEntry"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND type IN ('cost','expense')
         AND date >= '${from}' AND date <= '${t}'
         ${cashBook}
       GROUP BY 1 ORDER BY 1 ASC`,
    );
  }

  // --- Overview finance slice (windowed CTE style) ---
  add(
    'overview.ledgerFinanceSlice.30d',
    'overview',
    '30d',
    `WITH windowed AS (
       SELECT date, type, amount, category
       FROM "LedgerEntry"
       WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
         AND date >= '${f30}' AND date <= '${t}'
         ${cashBook}
     )
     SELECT
       COALESCE(SUM(amount) FILTER (WHERE type = 'revenue'), 0) AS revenue,
       COALESCE(SUM(amount) FILTER (WHERE type <> 'revenue'), 0) AS costs
     FROM windowed`,
  );

  // --- Daily finance rollup (fast path) ---
  add(
    'rollup.sumDailyFinance.30d',
    'rollup',
    '30d',
    `SELECT COALESCE(SUM(revenue),0) AS revenue, COALESCE(SUM(costs),0) AS costs,
            COALESCE(SUM(expenses),0) AS expenses, COALESCE(SUM(net),0) AS net
     FROM "TenantDailyFinance"
     WHERE "tenantId" = '${VA}' AND date >= '${f30}'::date AND date <= '${t}'::date`,
  );
  add(
    'rollup.groupByTenant.30d',
    'rollup',
    '30d',
    `SELECT "tenantId", COALESCE(SUM(revenue),0) AS revenue
     FROM "TenantDailyFinance"
     WHERE "tenantId" IN (${tenantList})
       AND date >= '${f30}'::date AND date <= '${t}'::date
     GROUP BY "tenantId"`,
  );
  add(
    'rollup.trendByMonth.365d',
    'rollup',
    '365d',
    `SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS "monthKey",
            to_char(date_trunc('month', date), 'Mon YY') AS label,
            COALESCE(SUM(revenue),0) AS revenue
     FROM "TenantDailyFinance"
     WHERE "tenantId" IN (${tenantList})
       AND date >= '${f365}'::date AND date <= '${t}'::date
     GROUP BY 1, 2 ORDER BY 1`,
  );

  // --- Stock ---
  add(
    'stock.itemMetrics',
    'stock',
    'snapshot',
    `SELECT
       COUNT(*)::bigint AS total_sku,
       COALESCE(SUM(quantity), 0)::bigint AS total_units,
       COALESCE(SUM(quantity * "costPrice"), 0) AS stock_value,
       COUNT(*) FILTER (WHERE status IN ('low_stock', 'out_of_stock'))::bigint AS low_stock_count,
       COUNT(*) FILTER (WHERE status = 'out_of_stock')::bigint AS out_of_stock_count
     FROM "Item"
     WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL`,
  );
  add(
    'stock.movementMetrics.30d',
    'stock',
    '30d',
    `SELECT
       COUNT(*) FILTER (WHERE type = 'inbound' AND date >= '${ts}' AND date <= '${te}')::bigint AS today_inbound,
       COUNT(*) FILTER (WHERE type = 'outbound' AND date >= '${ts}' AND date <= '${te}')::bigint AS today_outbound,
       COUNT(*) FILTER (WHERE date >= '${f30}' AND date <= '${t}')::bigint AS movement_count,
       COUNT(*) FILTER (WHERE date >= '${pf}' AND date <= '${pt}')::bigint AS prior_movement_count
     FROM "StockMovement"
     WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL`,
  );
  add(
    'stock.byCategoryValue',
    'stock',
    'snapshot',
    `SELECT COALESCE(category, 'Uncategorized') AS label,
            COALESCE(SUM(quantity * "costPrice"), 0) AS value
     FROM "Item"
     WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
     GROUP BY 1 ORDER BY value DESC LIMIT 12`,
  );
  add(
    'stock.lowStockItems',
    'stock',
    'snapshot',
    `SELECT id, name, sku, quantity, status
     FROM "Item"
     WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
       AND status IN ('low_stock', 'out_of_stock')
     ORDER BY quantity ASC LIMIT 50`,
  );
  add(
    'stock.topValueItems',
    'stock',
    'snapshot',
    `SELECT id, name, sku, quantity, (quantity * "costPrice") AS value
     FROM "Item"
     WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL AND quantity > 0
     ORDER BY value DESC LIMIT 20`,
  );
  add(
    'stock.movementTrend.30d',
    'stock',
    '30d',
    `SELECT date_trunc('day', date) AS bucket, type::text, COUNT(*)::bigint AS n
     FROM "StockMovement"
     WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
       AND date >= '${f30}' AND date <= '${t}'
     GROUP BY 1, 2 ORDER BY 1`,
  );

  // --- Jobs ---
  add(
    'jobs.costSummary.30d',
    'jobs',
    '30d',
    `WITH materials AS (
       SELECT jm."jobId", SUM(jm."totalCost") AS total
       FROM "JobMaterial" jm
       INNER JOIN "Job" jw ON jw.id = jm."jobId"
       WHERE jw."tenantId" = '${VA}' AND jw."deletedAt" IS NULL
         AND jw."createdAt" >= '${f30}' AND jw."createdAt" <= '${t}'
       GROUP BY jm."jobId"
     ),
     labour AS (
       SELECT jl."jobId", SUM(jl."totalCost") AS total
       FROM "JobLabour" jl
       INNER JOIN "Job" jw ON jw.id = jl."jobId"
       WHERE jw."tenantId" = '${VA}' AND jw."deletedAt" IS NULL
         AND jw."createdAt" >= '${f30}' AND jw."createdAt" <= '${t}'
       GROUP BY jl."jobId"
     )
     SELECT COUNT(*)::bigint AS job_count,
            COALESCE(SUM(COALESCE(m.total,0) + COALESCE(l.total,0)),0) AS total_cost
     FROM "Job" j
     LEFT JOIN materials m ON m."jobId" = j.id
     LEFT JOIN labour l ON l."jobId" = j.id
     WHERE j."tenantId" = '${VA}' AND j."deletedAt" IS NULL
       AND j."createdAt" >= '${f30}' AND j."createdAt" <= '${t}'`,
  );
  add(
    'jobs.avgTurnaround.30d',
    'jobs',
    '30d',
    `SELECT AVG(GREATEST(0, EXTRACT(EPOCH FROM (j."updatedAt" - j."createdAt")) / 86400.0)) AS avg_days
     FROM "Job" j
     WHERE j."tenantId" = '${VA}' AND j."deletedAt" IS NULL
       AND j.status = 'Delivered'
       AND j."createdAt" >= '${f30}' AND j."createdAt" <= '${t}'`,
  );
  add(
    'jobs.tableRows.30d',
    'jobs',
    '30d',
    `SELECT j.id, j.reference, j.status::text, j."customerName", j."createdAt"
     FROM "Job" j
     WHERE j."tenantId" = '${VA}' AND j."deletedAt" IS NULL
       AND j."createdAt" >= '${f30}' AND j."createdAt" <= '${t}'
     ORDER BY j."createdAt" DESC LIMIT 50`,
  );

  // --- Outstanding / receivables ---
  add(
    'finance.outstandingReceivables.30d',
    'finance',
    '30d',
    `SELECT COALESCE(SUM(GREATEST(total - "totalPaid", 0)), 0) AS outstanding
     FROM "Sale"
     WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
       AND status NOT IN ('draft', 'quotation')
       AND "paymentStatus" IN ('due','partial')
       AND date >= '${f30}' AND date <= '${t}'`,
  );

  // --- Group multi-tenant ---
  add(
    'group.revenueByTenant.30d',
    'group',
    '30d',
    `SELECT "tenantId", COALESCE(SUM(amount),0) AS revenue
     FROM "LedgerEntry"
     WHERE "tenantId" IN (${tenantList}) AND "deletedAt" IS NULL
       AND type = 'revenue'
       AND date >= '${f30}' AND date <= '${t}'
       ${cashBook}
     GROUP BY "tenantId"`,
  );
  add(
    'group.jobsByTenant.30d',
    'group',
    '30d',
    `SELECT "tenantId", COUNT(*)::bigint AS n
     FROM "Job"
     WHERE "tenantId" IN (${tenantList}) AND "deletedAt" IS NULL
       AND "createdAt" >= '${f30}' AND "createdAt" <= '${t}'
     GROUP BY "tenantId"`,
  );

  // --- Payment accounts ---
  add(
    'payments.accountBalances',
    'payments',
    'snapshot',
    `SELECT a.id, a.name, a.currency,
            COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0) AS balance
     FROM "PaymentAccount" a
     LEFT JOIN "AccountTransaction" t
       ON t."accountId" = a.id AND t."deletedAt" IS NULL
     WHERE a."tenantId" = '${VA}' AND a."deletedAt" IS NULL
     GROUP BY a.id, a.name, a.currency
     ORDER BY a.name ASC`,
  );

  // --- Appointments (may be empty for VA) ---
  add(
    'appointments.kpi.30d',
    'appointments',
    '30d',
    `SELECT COUNT(*)::bigint AS n,
            COUNT(*) FILTER (WHERE status::text = 'no_show')::bigint AS no_shows
     FROM "Appointment"
     WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
       AND "startTime" >= '${f30}' AND "startTime" <= '${t}'`,
  );

  // --- Available stock reservation ---
  add(
    'stock.reservedQtyBySku',
    'stock',
    'snapshot',
    `SELECT UPPER(line->>'sku') AS sku,
            COALESCE(SUM((line->>'quantity')::numeric), 0)::bigint AS reserved
     FROM "Requisition" r
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(r.lines::jsonb) = 'array' THEN r.lines::jsonb ELSE '[]'::jsonb END
     ) AS line
     WHERE r."sourceTenantId" = '${VA}'
       AND r.status = 'Approved'
       AND r."deletedAt" IS NULL
       AND COALESCE(line->>'sku', '') <> ''
     GROUP BY UPPER(line->>'sku')
     LIMIT 200`,
  );

  return q;
}

async function main() {
  const prisma = await connect();
  const catalog = buildCatalog();
  const results: BenchRow[] = [];

  console.error(`Benching ${catalog.length} queries against ${VA}…`);

  try {
    // Warm connection
    await prisma.$queryRawUnsafe('SELECT 1');

    for (let i = 0; i < catalog.length; i++) {
      const q = catalog[i]!;
      process.stderr.write(`  [${i + 1}/${catalog.length}] ${q.id}\n`);
      results.push(await benchOne(prisma, q.id, q.group, q.window, q.sql));
    }

    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    const ranked = [...ok].sort((a, b) => b.explainMs - a.explainMs);

    const byGroup: Record<
      string,
      { count: number; sumExplainMs: number; maxExplainMs: number; slowest: string }
    > = {};
    for (const r of ok) {
      const g = byGroup[r.group] ?? {
        count: 0,
        sumExplainMs: 0,
        maxExplainMs: 0,
        slowest: r.id,
      };
      g.count += 1;
      g.sumExplainMs += r.explainMs;
      if (r.explainMs > g.maxExplainMs) {
        g.maxExplainMs = r.explainMs;
        g.slowest = r.id;
      }
      byGroup[r.group] = g;
    }

    const out = {
      branch: 'chion/sql-speed-bench',
      tenant: VA,
      generatedAt: new Date().toISOString(),
      catalogSize: catalog.length,
      ok: ok.length,
      failed: failed.length,
      totals: {
        sumExplainMs: Math.round(ok.reduce((s, r) => s + r.explainMs, 0) * 100) / 100,
        sumWallMs: Math.round(ok.reduce((s, r) => s + r.wallMs, 0) * 100) / 100,
        p50ExplainMs: ranked[Math.floor(ranked.length / 2)]?.explainMs ?? 0,
        p95ExplainMs: ranked[Math.floor(ranked.length * 0.05)]?.explainMs ?? 0,
        maxExplainMs: ranked[0]?.explainMs ?? 0,
        seqScanCount: ok.filter((r) => r.seqScan).length,
      },
      byGroup,
      slowest20: ranked.slice(0, 20).map((r) => ({
        id: r.id,
        group: r.group,
        window: r.window,
        explainMs: r.explainMs,
        wallMs: r.wallMs,
        seqScan: r.seqScan,
        indexes: r.indexes,
      })),
      all: ranked.concat(failed),
      failures: failed,
    };

    const outDir = join(__dirname, '../../../../docs/migration-audits');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, 'SQL_BENCH_RESULTS.json');
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ wrote: outPath, ...out.totals, slowest5: out.slowest20.slice(0, 5) }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
