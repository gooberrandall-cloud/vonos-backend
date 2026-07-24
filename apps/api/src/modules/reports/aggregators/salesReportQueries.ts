import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import {
  buildCompositeCursorWhere,
  decodeCompositeCursor,
  nextCompositeCursor,
} from '../../../common/utils/pagination';
import { runPool } from '../../../common/utils/mapPool';
import { toNumber } from '../../../common/utils/serializers';
import { bucketLabel, type DateWindow } from './date-utils';
import type { AggregatedProductSale } from './productSales';
import { computeJobRevenueTotal } from './jobSalesData';

const NEON_QUERY_CONCURRENCY = 2;

export interface SalesKpiSnapshot {
  transactionCount: number;
  revenue: number;
  refundedCount: number;
  currency: string;
}

export interface SalesTrendRow {
  label: string;
  revenue: number;
}

export interface PaymentStatusRow {
  label: string;
  value: number;
}

export interface HourlyOrderRow {
  label: string;
  orders: number;
}

const saleBaseWhere = (tenantId: string, from: Date, to: Date) => ({
  tenantId,
  deletedAt: null,
  status: { not: 'draft' as const },
  date: { gte: from, lte: to },
});

export async function salesCurrency(
  db: TenantScopedPrisma,
  tenantId: string,
): Promise<string> {
  const row = await db.sale.findFirst({
    where: { tenantId, deletedAt: null },
    select: { currency: true },
    orderBy: { id: 'asc' },
  });
  return row?.currency ?? 'NGN';
}

export async function salesKpiSnapshot(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<SalesKpiSnapshot> {
  const [agg, refundedCount, currency] = await runPool(
    [
      () =>
        db.sale.aggregate({
          where: saleBaseWhere(tenantId, from, to),
          _count: { _all: true },
          _sum: { total: true },
        }),
      () =>
        db.sale.count({
          where: {
            ...saleBaseWhere(tenantId, from, to),
            status: { in: ['refunded', 'partially_refunded', 'written_off'] },
          },
        }),
      () => salesCurrency(db, tenantId),
    ],
    NEON_QUERY_CONCURRENCY,
  );

  return {
    transactionCount: agg._count._all,
    revenue: toNumber(agg._sum.total ?? 0),
    refundedCount,
    currency,
  };
}

function dateTruncUnit(spanDays: number): 'hour' | 'day' | 'month' {
  if (spanDays <= 2) return 'hour';
  if (spanDays <= 60) return 'day';
  return 'month';
}

export async function salesRevenueTrend(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<SalesTrendRow[]> {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const unit = dateTruncUnit(spanDays);

  const rows = await db.$queryRaw<
    Array<{ bucket: Date; revenue: Prisma.Decimal | null }>
  >`
    SELECT date_trunc(${unit}, date) AS bucket, COALESCE(SUM(total), 0) AS revenue
    FROM "Sale"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status::text <> 'draft'
      AND date >= ${window.from}
      AND date <= ${window.to}
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  return rows.map((row) => ({
    label: bucketLabel(row.bucket, spanDays),
    revenue: Math.round(toNumber(row.revenue ?? 0)),
  }));
}

export async function topProductsInWindow(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
  limit = 12,
): Promise<AggregatedProductSale[]> {
  const rows = await db.$queryRaw<
    Array<{
      sku: string;
      label: string;
      itemId: string | null;
      units: Prisma.Decimal | null;
      revenue: Prisma.Decimal | null;
    }>
  >`
    SELECT
      MAX(COALESCE(NULLIF(TRIM(sl.sku), ''), sl.name)) AS sku,
      MAX(sl.name) AS label,
      MAX(sl."itemId") AS "itemId",
      COALESCE(SUM(sl.quantity), 0) AS units,
      COALESCE(SUM(sl."lineTotal"), 0) AS revenue
    FROM "SaleLine" sl
    INNER JOIN "Sale" s ON s.id = sl."saleId"
    WHERE s."tenantId" = ${tenantId}
      AND s."deletedAt" IS NULL
      AND s.status::text <> 'draft'
      AND s.date >= ${from}
      AND s.date <= ${to}
    GROUP BY LOWER(COALESCE(NULLIF(TRIM(sl.sku), ''), sl.name))
    ORDER BY units DESC, revenue DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    label: row.label,
    sku: row.sku,
    units: toNumber(row.units ?? 0),
    revenue: toNumber(row.revenue ?? 0),
    itemId: row.itemId,
  }));
}

export async function paymentStatusBreakdown(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<PaymentStatusRow[]> {
  const rows = await db.$queryRaw<
    Array<{ label: string; value: bigint }>
  >`
    SELECT COALESCE("paymentStatus"::text, 'unknown') AS label, COUNT(*)::bigint AS value
    FROM "Sale"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status::text <> 'draft'
      AND date >= ${from}
      AND date <= ${to}
    GROUP BY label
    ORDER BY value DESC
  `;

  return rows.map((row) => ({
    label: row.label,
    value: Number(row.value),
  }));
}

export async function salesOrderTrend(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<Array<{ label: string; orders: number }>> {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const unit = dateTruncUnit(spanDays);

  const rows = await db.$queryRaw<Array<{ bucket: Date; orders: bigint }>>`
    SELECT date_trunc(${unit}, date) AS bucket, COUNT(*)::bigint AS orders
    FROM "Sale"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status::text <> 'draft'
      AND date >= ${window.from}
      AND date <= ${window.to}
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  return rows.map((row) => ({
    label: bucketLabel(row.bucket, spanDays),
    orders: Number(row.orders),
  }));
}

export async function hourlyOrderCounts(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<HourlyOrderRow[]> {
  const rows = await db.$queryRaw<Array<{ hour: number; orders: bigint }>>`
    SELECT EXTRACT(HOUR FROM date)::int AS hour, COUNT(*)::bigint AS orders
    FROM "Sale"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status::text <> 'draft'
      AND date >= ${from}
      AND date <= ${to}
    GROUP BY hour
    ORDER BY hour ASC
  `;

  return rows.map((row) => ({
    label: `${row.hour}:00`,
    orders: Number(row.orders),
  }));
}

function money(value: Prisma.Decimal | number | null | undefined): number {
  return Math.round(toNumber(value ?? 0) * 100) / 100;
}

/** Thin wrapper used by transaction report handlers. Falls back to job revenue for VA. */
export async function sumSalesWindow(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<{ revenue: number; count: number; currency: string }> {
  const snap = await salesKpiSnapshot(db, tenantId, window.from, window.to);
  if (snap.revenue > 0 || snap.transactionCount > 0) {
    return {
      revenue: snap.revenue,
      count: snap.transactionCount,
      currency: snap.currency,
    };
  }

  const [jobTotals, jobCount] = await Promise.all([
    computeJobRevenueTotal(db, tenantId, window.from.toISOString(), window.to.toISOString()),
    db.job.count({
      where: {
        tenantId,
        deletedAt: null,
        status: 'Delivered',
        updatedAt: { gte: window.from, lte: window.to },
        sales: { none: { deletedAt: null } },
      },
    }),
  ]);

  if (jobTotals.revenue <= 0 && jobCount === 0) {
    return {
      revenue: snap.revenue,
      count: snap.transactionCount,
      currency: snap.currency,
    };
  }

  return {
    revenue: jobTotals.revenue,
    count: jobCount,
    currency: snap.currency,
  };
}

export async function salesRevenueByBucket(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<Array<{ key: string; label: string; sales: number }>> {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const useDay = spanDays <= 60;

  const rows = useDay
    ? await db.$queryRaw<
        Array<{ bucket: Date; sales: Prisma.Decimal | null }>
      >`
        SELECT date_trunc('day', date) AS bucket, COALESCE(SUM(total), 0) AS sales
        FROM "Sale"
        WHERE "tenantId" = ${tenantId}
          AND "deletedAt" IS NULL
          AND status::text <> 'draft'
          AND date >= ${window.from}
          AND date <= ${window.to}
        GROUP BY 1 ORDER BY 1 ASC
      `
    : await db.$queryRaw<
        Array<{ bucket: Date; sales: Prisma.Decimal | null }>
      >`
        SELECT date_trunc('month', date) AS bucket, COALESCE(SUM(total), 0) AS sales
        FROM "Sale"
        WHERE "tenantId" = ${tenantId}
          AND "deletedAt" IS NULL
          AND status::text <> 'draft'
          AND date >= ${window.from}
          AND date <= ${window.to}
        GROUP BY 1 ORDER BY 1 ASC
      `;

  return rows.map((row) => {
    const d = row.bucket;
    const label = useDay
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    const key = useDay
      ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      : `${d.getFullYear()}-${d.getMonth()}`;
    return { key, label, sales: money(row.sales) };
  });
}

/** HQ6 home — purchase value trend by day/month bucket. */
export async function purchaseRevenueByBucket(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<Array<{ key: string; label: string; purchase: number }>> {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const useDay = spanDays <= 60;
  const lineCost = Prisma.sql`
    COALESCE((elem->>'quantity')::numeric, 0)
    * COALESCE((elem->>'unitCost')::numeric, 0)
  `;

  const rows = useDay
    ? await db.$queryRaw<Array<{ bucket: Date; purchase: Prisma.Decimal | null }>>`
        SELECT date_trunc('day', sm.date) AS bucket,
          COALESCE(SUM(${lineCost}), 0) AS purchase
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
          AND sm.date >= ${window.from}
          AND sm.date <= ${window.to}
        GROUP BY 1 ORDER BY 1 ASC
      `
    : await db.$queryRaw<Array<{ bucket: Date; purchase: Prisma.Decimal | null }>>`
        SELECT date_trunc('month', sm.date) AS bucket,
          COALESCE(SUM(${lineCost}), 0) AS purchase
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
          AND sm.date >= ${window.from}
          AND sm.date <= ${window.to}
        GROUP BY 1 ORDER BY 1 ASC
      `;

  return rows.map((row) => {
    const d = row.bucket;
    const label = useDay
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    const key = useDay
      ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      : `${d.getFullYear()}-${d.getMonth()}`;
    return { key, label, purchase: money(row.purchase) };
  });
}

export async function ledgerCostByBucket(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<Array<{ key: string; purchases: number }>> {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const useDay = spanDays <= 60;

  const rows = useDay
    ? await db.$queryRaw<
        Array<{ bucket: Date; purchases: Prisma.Decimal | null }>
      >`
        SELECT date_trunc('day', date) AS bucket, COALESCE(SUM(amount), 0) AS purchases
        FROM "LedgerEntry"
        WHERE "tenantId" = ${tenantId}
          AND "deletedAt" IS NULL
          AND type::text = 'cost'
          AND date >= ${window.from}
          AND date <= ${window.to}
        GROUP BY 1 ORDER BY 1 ASC
      `
    : await db.$queryRaw<
        Array<{ bucket: Date; purchases: Prisma.Decimal | null }>
      >`
        SELECT date_trunc('month', date) AS bucket, COALESCE(SUM(amount), 0) AS purchases
        FROM "LedgerEntry"
        WHERE "tenantId" = ${tenantId}
          AND "deletedAt" IS NULL
          AND type::text = 'cost'
          AND date >= ${window.from}
          AND date <= ${window.to}
        GROUP BY 1 ORDER BY 1 ASC
      `;

  return rows.map((row) => {
    const d = row.bucket;
    const key = useDay
      ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      : `${d.getFullYear()}-${d.getMonth()}`;
    return { key, purchases: money(row.purchases) };
  });
}

export async function salesByDay(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<Array<{ day: string; label: string; count: number; revenue: number }>> {
  const rows = await db.$queryRaw<
    Array<{ day: Date; count: bigint; revenue: Prisma.Decimal | null }>
  >`
    SELECT
      date_trunc('day', date) AS day,
      COUNT(*)::bigint AS count,
      COALESCE(SUM(total), 0) AS revenue
    FROM "Sale"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status::text <> 'draft'
      AND date >= ${window.from}
      AND date <= ${window.to}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  return rows.map((row) => {
    const d = row.day;
    return {
      day: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
      count: Number(row.count),
      revenue: money(row.revenue),
    };
  });
}

export async function salesByCreatedBy(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<
  Array<{ staff: string; count: number; revenue: number; currency: string }>
> {
  const rows = await db.$queryRaw<
    Array<{
      staff: string;
      count: bigint;
      revenue: Prisma.Decimal | null;
      currency: string | null;
    }>
  >`
    SELECT
      COALESCE(NULLIF(TRIM("createdByName"), ''), 'Unassigned') AS staff,
      COUNT(*)::bigint AS count,
      COALESCE(SUM(total), 0) AS revenue,
      MAX(currency) AS currency
    FROM "Sale"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status::text <> 'draft'
      AND date >= ${window.from}
      AND date <= ${window.to}
    GROUP BY 1
    ORDER BY SUM(total) DESC
    LIMIT 100
  `;

  return rows.map((row) => ({
    staff: row.staff,
    count: Number(row.count),
    revenue: money(row.revenue),
    currency: row.currency ?? 'NGN',
  }));
}

/** Service staff report — assigned employee / cleaner on the sale (not sale creator). */
export async function salesByServiceStaff(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<
  Array<{ staff: string; count: number; revenue: number; currency: string }>
> {
  const rows = await db.$queryRaw<
    Array<{
      staff: string;
      count: bigint;
      revenue: Prisma.Decimal | null;
      currency: string | null;
    }>
  >`
    SELECT
      COALESCE(
        NULLIF(TRIM(s."cleanerName"), ''),
        NULLIF(TRIM(e.name), ''),
        NULLIF(TRIM(u.name), ''),
        'Unassigned'
      ) AS staff,
      COUNT(*)::bigint AS count,
      COALESCE(SUM(s.total), 0) AS revenue,
      MAX(s.currency) AS currency
    FROM "Sale" s
    LEFT JOIN "Employee" e
      ON e.id = s."serviceStaffEmployeeId"
      AND e."deletedAt" IS NULL
    LEFT JOIN "User" u ON u.id = s."cleanerUserId"
    WHERE s."tenantId" = ${tenantId}
      AND s."deletedAt" IS NULL
      AND s.status::text <> 'draft'
      AND s.date >= ${window.from}
      AND s.date <= ${window.to}
    GROUP BY 1
    ORDER BY SUM(s.total) DESC
    LIMIT 100
  `;

  return rows.map((row) => ({
    staff: row.staff,
    count: Number(row.count),
    revenue: money(row.revenue),
    currency: row.currency ?? 'NGN',
  }));
}

export async function salesByPaymentStatus(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<Array<{ status: string; count: number; revenue: number }>> {
  const rows = await db.$queryRaw<
    Array<{
      status: string;
      count: bigint;
      revenue: Prisma.Decimal | null;
    }>
  >`
    SELECT
      COALESCE("paymentStatus"::text, 'unknown') AS status,
      COUNT(*)::bigint AS count,
      COALESCE(SUM(total), 0) AS revenue
    FROM "Sale"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status::text <> 'draft'
      AND date >= ${window.from}
      AND date <= ${window.to}
    GROUP BY 1
  `;

  return rows.map((row) => ({
    status: row.status,
    count: Number(row.count),
    revenue: money(row.revenue),
  }));
}

export async function taxDiscountAggregates(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<{
  netSales: number;
  discounts: number;
  lineSubtotal: number;
  count: number;
  currency: string;
}> {
  const [snap, lineAgg] = await Promise.all([
    salesKpiSnapshot(db, tenantId, window.from, window.to),
    db.$queryRaw<
      Array<{
        discounts: Prisma.Decimal | null;
        line_subtotal: Prisma.Decimal | null;
      }>
    >`
      SELECT
        COALESCE(SUM(
          COALESCE(sl."discountAmount", 0)
          + GREATEST(0, sl.quantity * sl."unitPrice" - sl."lineTotal")
        ), 0) AS discounts,
        COALESCE(SUM(sl.quantity * sl."unitPrice"), 0) AS line_subtotal
      FROM "SaleLine" sl
      INNER JOIN "Sale" s ON s.id = sl."saleId"
      WHERE s."tenantId" = ${tenantId}
        AND s."deletedAt" IS NULL
        AND s.status::text <> 'draft'
        AND s.date >= ${window.from}
        AND s.date <= ${window.to}
    `,
  ]);

  return {
    netSales: snap.revenue,
    discounts: money(lineAgg[0]?.discounts),
    lineSubtotal: money(lineAgg[0]?.line_subtotal),
    count: snap.transactionCount,
    currency: snap.currency,
  };
}

/** Ultimate POS tax-report card metrics (purchases / sales / dues). */
export async function taxReportSummaryAggregates(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<{
  currency: string;
  totalPurchase: number;
  purchaseIncludingTax: number;
  purchaseReturnIncludingTax: number;
  purchaseDue: number;
  totalSale: number;
  saleIncludingTax: number;
  sellReturnIncludingTax: number;
  saleDue: number;
}> {
  const lineCost = Prisma.sql`
    COALESCE((elem->>'quantity')::numeric, 0)
    * COALESCE((elem->>'unitCost')::numeric, 0)
  `;

  const [currency, purchaseRows, saleRows, dueRows] = await runPool(
    [
    () => salesCurrency(db, tenantId),
    () => db.$queryRaw<
      Array<{
        total_purchase: Prisma.Decimal | null;
        purchase_inc_tax: Prisma.Decimal | null;
        purchase_return: Prisma.Decimal | null;
        purchase_due: Prisma.Decimal | null;
      }>
    >`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN sm.source::text = 'standard' THEN ${lineCost}
            ELSE 0
          END
        ), 0) AS total_purchase,
        COALESCE(SUM(
          CASE
            WHEN sm.source::text = 'standard' THEN ${lineCost}
            ELSE 0
          END
        ), 0) AS purchase_inc_tax,
        COALESCE(SUM(
          CASE
            WHEN sm.source::text = 'purchase_return' THEN ${lineCost}
            ELSE 0
          END
        ), 0) AS purchase_return,
        COALESCE(SUM(
          CASE
            WHEN sm.source::text = 'standard'
              AND sm."paymentStatus"::text IN ('due', 'partial', 'overdue')
            THEN ${lineCost}
            ELSE 0
          END
        ), 0) AS purchase_due
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
        AND sm.date >= ${window.from}
        AND sm.date <= ${window.to}
    `,
    () => db.$queryRaw<
      Array<{
        total_sale: Prisma.Decimal | null;
        sale_inc_tax: Prisma.Decimal | null;
        sell_return: Prisma.Decimal | null;
      }>
    >`
      SELECT
        COALESCE((
          SELECT SUM(sl.quantity * sl."unitPrice")
          FROM "SaleLine" sl
          INNER JOIN "Sale" s ON s.id = sl."saleId"
          WHERE s."tenantId" = ${tenantId}
            AND s."deletedAt" IS NULL
            AND s.status::text NOT IN (
              'draft', 'quotation', 'refunded', 'partially_refunded', 'written_off'
            )
            AND s.date >= ${window.from}
            AND s.date <= ${window.to}
        ), 0) AS total_sale,
        COALESCE((
          SELECT SUM(s.total)
          FROM "Sale" s
          WHERE s."tenantId" = ${tenantId}
            AND s."deletedAt" IS NULL
            AND s.status::text NOT IN (
              'draft', 'quotation', 'refunded', 'partially_refunded', 'written_off'
            )
            AND s.date >= ${window.from}
            AND s.date <= ${window.to}
        ), 0) AS sale_inc_tax,
        COALESCE((
          SELECT SUM(s.total)
          FROM "Sale" s
          WHERE s."tenantId" = ${tenantId}
            AND s."deletedAt" IS NULL
            AND s.status::text IN (
              'refunded', 'partially_refunded', 'written_off'
            )
            AND s.date >= ${window.from}
            AND s.date <= ${window.to}
        ), 0) AS sell_return
    `,
    () => db.$queryRaw<[{ sale_due: Prisma.Decimal | null }]>`
      SELECT COALESCE(SUM(
        GREATEST(0, s.total - COALESCE(p.paid, 0))
      ), 0) AS sale_due
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
        AND s.date >= ${window.from}
        AND s.date <= ${window.to}
    `,
  ],
    NEON_QUERY_CONCURRENCY,
  );

  const purchase = purchaseRows[0];
  const sale = saleRows[0];

  return {
    currency,
    totalPurchase: money(purchase?.total_purchase),
    purchaseIncludingTax: money(purchase?.purchase_inc_tax),
    purchaseReturnIncludingTax: money(purchase?.purchase_return),
    purchaseDue: money(purchase?.purchase_due),
    totalSale: money(sale?.total_sale),
    saleIncludingTax: money(sale?.sale_inc_tax),
    sellReturnIncludingTax: money(sale?.sell_return),
    saleDue: money(dueRows[0]?.sale_due),
  };
}

export interface PeriodInvoiceRef {
  id: string;
  recordType: 'sale' | 'purchase' | 'job';
  /** Sell/purchase document reference (POS invoice no / PO ref). */
  reference: string;
  /** Formal invoice document reference when linked. */
  invoiceNo: string;
  date: Date;
  total: number;
  tax: number;
  discount: number;
  paymentStatus: string | null;
  paymentMethod: string | null;
  party: string;
  taxNumber: string | null;
  createdByName: string | null;
  locationCode: string | null;
  /** Job id when this row is a job invoice (for navigation). */
  jobId?: string | null;
}

export interface PeriodInvoicePage {
  rows: PeriodInvoiceRef[];
  hasMore: boolean;
  nextCursor: string | null;
  pageSize: number;
}

const PERIOD_DOC_DEFAULT_PAGE = 25;
const PERIOD_DOC_MAX_PAGE = 100;

function periodPageSize(limit?: number): number {
  return Math.min(
    Math.max(limit ?? PERIOD_DOC_DEFAULT_PAGE, 1),
    PERIOD_DOC_MAX_PAGE,
  );
}

function periodCursorWhere(
  cursor: string | undefined,
  dateField: string,
): Prisma.JsonObject | undefined {
  return buildCompositeCursorWhere(
    dateField,
    'desc',
    decodeCompositeCursor(cursor),
    'date',
  ) as Prisma.JsonObject | undefined;
}

function matchesPeriodSearch(
  row: PeriodInvoiceRef,
  search?: string,
): boolean {
  const q = search?.trim().toLowerCase();
  if (!q) return true;
  return [
    row.reference,
    row.invoiceNo,
    row.party,
    row.taxNumber,
    row.paymentStatus,
    row.paymentMethod,
    row.createdByName,
    row.locationCode,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
}

/** Period sales (+ job invoices) for purchase-sale / tax detail tables. */
export async function periodSaleRefsPage(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
  options?: { cursor?: string; limit?: number; search?: string },
): Promise<PeriodInvoicePage> {
  const pageSize = periodPageSize(options?.limit);
  const take = pageSize + 1;
  const saleCursor = periodCursorWhere(options?.cursor, 'date');
  const invoiceCursor = periodCursorWhere(options?.cursor, 'documentDate');

  const [sales, jobInvoices] = await Promise.all([
    db.sale.findMany({
      where: {
        ...saleBaseWhere(tenantId, window.from, window.to),
        ...(saleCursor as object | undefined),
      },
      select: {
        id: true,
        reference: true,
        date: true,
        total: true,
        taxAmount: true,
        discountAmount: true,
        paymentStatus: true,
        paymentMethod: true,
        createdByName: true,
        locationCode: true,
        jobId: true,
        customer: { select: { name: true, taxNumber: true } },
        invoice: {
          select: { reference: true, taxAmount: true, discountAmount: true },
        },
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take,
    }),
    db.invoice.findMany({
      where: {
        tenantId,
        deletedAt: null,
        kind: 'job_invoice',
        documentDate: { gte: window.from, lte: window.to },
        ...(invoiceCursor as object | undefined),
      },
      select: {
        id: true,
        reference: true,
        documentDate: true,
        total: true,
        taxAmount: true,
        discountAmount: true,
        paymentStatus: true,
        contactName: true,
        kind: true,
        jobId: true,
        customer: { select: { name: true, taxNumber: true } },
        job: {
          select: {
            reference: true,
            createdByName: true,
            locationCode: true,
            customerName: true,
          },
        },
      },
      orderBy: [{ documentDate: 'desc' }, { id: 'desc' }],
      take,
    }),
  ]);

  const fromSales: PeriodInvoiceRef[] = sales.map((row) => ({
    id: row.id,
    recordType: row.jobId ? ('job' as const) : ('sale' as const),
    reference: row.reference,
    invoiceNo: row.invoice?.reference ?? row.reference,
    date: row.date,
    total: toNumber(row.total),
    tax: toNumber(row.invoice?.taxAmount ?? row.taxAmount ?? 0),
    discount: toNumber(row.invoice?.discountAmount ?? row.discountAmount ?? 0),
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    party: row.customer?.name ?? 'Walk-in Customer',
    taxNumber: row.customer?.taxNumber?.trim() || null,
    createdByName: row.createdByName ?? null,
    locationCode: row.locationCode ?? null,
    jobId: row.jobId,
  }));

  const saleJobIds = new Set(
    sales.map((row) => row.jobId).filter((id): id is string => Boolean(id)),
  );
  const fromJobs: PeriodInvoiceRef[] = jobInvoices
    .filter((row) => !row.jobId || !saleJobIds.has(row.jobId))
    .map((row) => ({
      id: row.jobId ?? row.id,
      recordType: 'job' as const,
      reference: row.job?.reference ?? row.reference,
      invoiceNo: row.reference,
      date: row.documentDate,
      total: toNumber(row.total),
      tax: toNumber(row.taxAmount ?? 0),
      discount: toNumber(row.discountAmount ?? 0),
      paymentStatus: row.paymentStatus,
      paymentMethod: null,
      party:
        row.customer?.name ??
        row.job?.customerName ??
        row.contactName ??
        'Walk-in Customer',
      taxNumber: row.customer?.taxNumber?.trim() || null,
      createdByName: row.job?.createdByName ?? null,
      locationCode: row.job?.locationCode ?? null,
      jobId: row.jobId,
    }));

  const merged = [...fromSales, ...fromJobs]
    .filter((row) => matchesPeriodSearch(row, options?.search))
    .sort((a, b) => {
      const byDate = b.date.getTime() - a.date.getTime();
      if (byDate !== 0) return byDate;
      return b.id.localeCompare(a.id);
    });

  const hasMore = merged.length > pageSize;
  const rows = hasMore ? merged.slice(0, pageSize) : merged;
  const last = rows[rows.length - 1];
  return {
    rows,
    hasMore,
    nextCursor:
      hasMore && last ? nextCompositeCursor(last, 'date', 'date') : null,
    pageSize,
  };
}

/** @deprecated Prefer periodSaleRefsPage — kept for callers that want a capped list. */
export async function recentSaleRefs(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
  limit = 500,
): Promise<PeriodInvoiceRef[]> {
  const page = await periodSaleRefsPage(db, tenantId, window, {
    limit: Math.min(limit, PERIOD_DOC_MAX_PAGE),
  });
  if (!page.hasMore || limit <= PERIOD_DOC_MAX_PAGE) {
    // Walk pages until we hit the requested cap.
    const rows = [...page.rows];
    let cursor = page.nextCursor;
    while (cursor && rows.length < limit) {
      const next = await periodSaleRefsPage(db, tenantId, window, {
        cursor,
        limit: Math.min(PERIOD_DOC_MAX_PAGE, limit - rows.length),
      });
      rows.push(...next.rows);
      cursor = next.nextCursor;
      if (!next.hasMore) break;
    }
    return rows.slice(0, limit);
  }
  return page.rows;
}

/** Period purchase invoices + inbound docs for detailed report tables. */
export async function periodPurchaseRefsPage(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
  options?: { cursor?: string; limit?: number; search?: string },
): Promise<PeriodInvoicePage> {
  const pageSize = periodPageSize(options?.limit);
  const take = pageSize + 1;
  const invoiceCursor = periodCursorWhere(options?.cursor, 'documentDate');
  const movementCursor = periodCursorWhere(options?.cursor, 'date');

  const [purchaseInvoices, inboundMovements] = await Promise.all([
    db.invoice.findMany({
      where: {
        tenantId,
        deletedAt: null,
        kind: 'purchase',
        documentDate: { gte: window.from, lte: window.to },
        ...(invoiceCursor as object | undefined),
      },
      select: {
        id: true,
        reference: true,
        documentDate: true,
        total: true,
        taxAmount: true,
        discountAmount: true,
        paymentStatus: true,
        contactName: true,
        supplier: { select: { name: true, taxNumber: true } },
        stockMovement: {
          select: {
            reference: true,
            createdByName: true,
            locationCode: true,
            paymentMethod: true,
            paymentStatus: true,
          },
        },
      },
      orderBy: [{ documentDate: 'desc' }, { id: 'desc' }],
      take,
    }),
    db.stockMovement.findMany({
      where: {
        tenantId,
        deletedAt: null,
        type: 'inbound',
        date: { gte: window.from, lte: window.to },
        invoice: null,
        ...(movementCursor as object | undefined),
      },
      select: {
        id: true,
        reference: true,
        date: true,
        paymentStatus: true,
        paymentMethod: true,
        createdByName: true,
        locationCode: true,
        lines: true,
        supplier: { select: { name: true, taxNumber: true } },
        notes: true,
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take,
    }),
  ]);

  const fromInvoices: PeriodInvoiceRef[] = purchaseInvoices.map((row) => ({
    id: row.id,
    recordType: 'purchase' as const,
    reference: row.stockMovement?.reference ?? row.reference,
    invoiceNo: row.reference,
    date: row.documentDate,
    total: toNumber(row.total),
    tax: toNumber(row.taxAmount ?? 0),
    discount: toNumber(row.discountAmount ?? 0),
    paymentStatus: row.paymentStatus ?? row.stockMovement?.paymentStatus ?? null,
    paymentMethod: row.stockMovement?.paymentMethod ?? null,
    party: row.supplier?.name ?? row.contactName ?? '—',
    taxNumber: row.supplier?.taxNumber?.trim() || null,
    createdByName: row.stockMovement?.createdByName ?? null,
    locationCode: row.stockMovement?.locationCode ?? null,
  }));

  const invoiceMovementRefs = new Set(
    fromInvoices.map((row) => row.reference).filter(Boolean),
  );

  const fromMovements: PeriodInvoiceRef[] = inboundMovements
    .filter((row) => !invoiceMovementRefs.has(row.reference))
    .map((row) => {
      const lines = Array.isArray(row.lines) ? row.lines : [];
      let total = 0;
      for (const line of lines) {
        if (!line || typeof line !== 'object') continue;
        const rec = line as Record<string, unknown>;
        const qty = Number(rec.quantity ?? rec.qty ?? 0);
        const unit = Number(
          rec.unitCost ?? rec.costPrice ?? rec.unitPrice ?? 0,
        );
        const lineTotal = Number(rec.lineTotal ?? qty * unit);
        if (Number.isFinite(lineTotal)) total += lineTotal;
      }
      const partyFromNotes =
        typeof row.notes === 'string'
          ? row.notes.split('|')[0]?.trim() || null
          : null;
      return {
        id: row.id,
        recordType: 'purchase' as const,
        reference: row.reference,
        invoiceNo: row.reference,
        date: row.date,
        total: Math.round(total * 100) / 100,
        tax: 0,
        discount: 0,
        paymentStatus: row.paymentStatus,
        paymentMethod: row.paymentMethod,
        party: row.supplier?.name ?? partyFromNotes ?? '—',
        taxNumber: row.supplier?.taxNumber?.trim() || null,
        createdByName: row.createdByName ?? null,
        locationCode: row.locationCode ?? null,
      };
    });

  const merged = [...fromInvoices, ...fromMovements]
    .filter((row) => matchesPeriodSearch(row, options?.search))
    .sort((a, b) => {
      const byDate = b.date.getTime() - a.date.getTime();
      if (byDate !== 0) return byDate;
      return b.id.localeCompare(a.id);
    });

  const hasMore = merged.length > pageSize;
  const rows = hasMore ? merged.slice(0, pageSize) : merged;
  const last = rows[rows.length - 1];
  return {
    rows,
    hasMore,
    nextCursor:
      hasMore && last ? nextCompositeCursor(last, 'date', 'date') : null,
    pageSize,
  };
}

/** @deprecated Prefer periodPurchaseRefsPage. */
export async function recentPurchaseRefs(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
  limit = 500,
): Promise<PeriodInvoiceRef[]> {
  const rows: PeriodInvoiceRef[] = [];
  let cursor: string | undefined;
  while (rows.length < limit) {
    const page = await periodPurchaseRefsPage(db, tenantId, window, {
      cursor,
      limit: Math.min(PERIOD_DOC_MAX_PAGE, limit - rows.length),
    });
    rows.push(...page.rows);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows.slice(0, limit);
}


export async function topProductsSold(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
  limit = 15,
): Promise<
  Array<{
    sku: string;
    name: string;
    units: number;
    revenue: number;
    itemId: string | null;
  }>
> {
  const rows = await topProductsInWindow(
    db,
    tenantId,
    window.from,
    window.to,
    limit,
  );
  return rows.map((row) => ({
    sku: row.sku,
    name: row.label,
    units: row.units,
    revenue: row.revenue,
    itemId: row.itemId,
  }));
}

export async function customerNameSegments(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<Array<{ group: string; count: number; revenue: number }>> {
  const rows = await db.$queryRaw<
    Array<{
      group: string;
      count: bigint;
      revenue: Prisma.Decimal | null;
    }>
  >`
    SELECT
      CASE
        WHEN s."customerId" IS NULL THEN 'Walk-in'
        ELSE COALESCE(UPPER(LEFT(TRIM(c.name), 1)), 'Account')
      END AS "group",
      COUNT(*)::bigint AS count,
      COALESCE(SUM(s.total), 0) AS revenue
    FROM "Sale" s
    LEFT JOIN "Customer" c ON c.id = s."customerId"
    WHERE s."tenantId" = ${tenantId}
      AND s."deletedAt" IS NULL
      AND s.status::text <> 'draft'
      AND s.date >= ${window.from}
      AND s.date <= ${window.to}
    GROUP BY 1
    ORDER BY SUM(s.total) DESC
  `;

  return rows.map((row) => ({
    group: row.group,
    count: Number(row.count),
    revenue: money(row.revenue),
  }));
}

export async function inboundPurchaseLines(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
  limit = 200,
): Promise<
  Array<{ reference: string; date: string; sku: string; quantity: number }>
> {
  const rows = await db.$queryRaw<
    Array<{
      reference: string;
      date: Date;
      sku: string;
      quantity: Prisma.Decimal | null;
    }>
  >`
    SELECT
      sm.reference,
      sm.date,
      COALESCE(elem->>'sku', elem->>'name', '—') AS sku,
      COALESCE((elem->>'quantity')::numeric, 0) AS quantity
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
      AND sm.date >= ${window.from}
      AND sm.date <= ${window.to}
    ORDER BY sm.date DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    reference: row.reference,
    date: row.date.toISOString().slice(0, 10),
    sku: row.sku,
    quantity: toNumber(row.quantity ?? 0),
  }));
}

export async function inboundDocCount(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<number> {
  return db.stockMovement.count({
    where: {
      tenantId,
      deletedAt: null,
      type: 'inbound',
      date: { gte: window.from, lte: window.to },
    },
  });
}

export { priorWindow, resolveDateWindow } from './date-utils';
