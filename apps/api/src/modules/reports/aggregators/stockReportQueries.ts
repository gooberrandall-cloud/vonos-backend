import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';
import { bucketLabel, type DateWindow } from './date-utils';

export interface StockItemRow {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  quantity: number;
  reorderPoint: number | null;
  costPrice: number;
  status: string;
  currency: string;
}

export interface StockMetrics {
  stockValue: number;
  totalSku: number;
  totalUnits: number;
  lowStockCount: number;
  outOfStockCount: number;
  todayInbound: number;
  todayOutbound: number;
  movementCount: number;
  priorMovementCount: number;
  velocity: number;
  priorVelocity: number;
  currency: string;
}

export interface CategoryValueRow {
  label: string;
  value: number;
}

export interface MovementTrendRow {
  label: string;
  inbound: number;
  outbound: number;
}

/**
 * Stock KPIs via 2 SQL round-trips (was 10 parallel Prisma calls — P2024 pool stampede).
 */
export async function stockMetrics(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
  prior: DateWindow,
  todayStart: Date,
  todayEnd: Date,
): Promise<StockMetrics> {
  const [itemRows, movementRows] = await Promise.all([
    db.$queryRaw<
      [
        {
          total_sku: bigint;
          total_units: bigint | null;
          stock_value: Prisma.Decimal | null;
          low_stock_count: bigint;
          out_of_stock_count: bigint;
          currency: string | null;
        },
      ]
    >`
      SELECT
        COUNT(*)::bigint AS total_sku,
        COALESCE(SUM(quantity), 0)::bigint AS total_units,
        COALESCE(SUM(quantity * "costPrice"), 0) AS stock_value,
        COUNT(*) FILTER (
          WHERE status IN ('low_stock', 'out_of_stock')
        )::bigint AS low_stock_count,
        COUNT(*) FILTER (WHERE status = 'out_of_stock')::bigint AS out_of_stock_count,
        (SELECT currency FROM "Item"
          WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
          ORDER BY id ASC LIMIT 1) AS currency
      FROM "Item"
      WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
    `,
    db.$queryRaw<
      [
        {
          today_inbound: bigint;
          today_outbound: bigint;
          movement_count: bigint;
          prior_movement_count: bigint;
        },
      ]
    >`
      SELECT
        COUNT(*) FILTER (
          WHERE type = 'inbound'
            AND date >= ${todayStart} AND date <= ${todayEnd}
        )::bigint AS today_inbound,
        COUNT(*) FILTER (
          WHERE type = 'outbound'
            AND date >= ${todayStart} AND date <= ${todayEnd}
        )::bigint AS today_outbound,
        COUNT(*) FILTER (
          WHERE date >= ${window.from} AND date <= ${window.to}
        )::bigint AS movement_count,
        COUNT(*) FILTER (
          WHERE date >= ${prior.from} AND date <= ${prior.to}
        )::bigint AS prior_movement_count
      FROM "StockMovement"
      WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
    `,
  ]);

  const item = itemRows[0];
  const movement = movementRows[0];
  const totalSku = Number(item?.total_sku ?? 0);
  const totalUnits = Number(item?.total_units ?? 0);
  const movementCount = Number(movement?.movement_count ?? 0);
  const priorMovementCount = Number(movement?.prior_movement_count ?? 0);
  const velocity =
    totalSku > 0 ? Number((movementCount / totalSku).toFixed(2)) : 0;
  const priorVelocity =
    totalSku > 0 ? Number((priorMovementCount / totalSku).toFixed(2)) : 0;

  return {
    stockValue: toNumber(item?.stock_value ?? 0),
    totalSku,
    totalUnits,
    lowStockCount: Number(item?.low_stock_count ?? 0),
    outOfStockCount: Number(item?.out_of_stock_count ?? 0),
    todayInbound: Number(movement?.today_inbound ?? 0),
    todayOutbound: Number(movement?.today_outbound ?? 0),
    movementCount,
    priorMovementCount,
    velocity,
    priorVelocity,
    currency: item?.currency ?? 'NGN',
  };
}

export async function itemsByCategoryValue(
  db: TenantScopedPrisma,
  tenantId: string,
  limit = 12,
): Promise<CategoryValueRow[]> {
  const rows = await db.$queryRaw<
    Array<{ label: string; value: Prisma.Decimal }>
  >`
    SELECT
      COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS label,
      COALESCE(SUM(quantity * "costPrice"), 0) AS value
    FROM "Item"
    WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
    GROUP BY 1
    ORDER BY value DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    label: row.label,
    value: toNumber(row.value),
  }));
}

export async function movementTrend(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<MovementTrendRow[]> {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const rows = await db.$queryRaw<
    Array<{ day: Date; inbound: bigint; outbound: bigint }>
  >`
    SELECT
      date_trunc('day', date) AS day,
      COUNT(*) FILTER (WHERE type = 'inbound')::bigint AS inbound,
      COUNT(*) FILTER (WHERE type = 'outbound')::bigint AS outbound
    FROM "StockMovement"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND date >= ${window.from}
      AND date <= ${window.to}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  return rows.map((row) => ({
    label: bucketLabel(row.day, spanDays),
    inbound: Number(row.inbound),
    outbound: Number(row.outbound),
  }));
}

export async function lowStockByCategory(
  db: TenantScopedPrisma,
  tenantId: string,
  limit = 12,
): Promise<CategoryValueRow[]> {
  const rows = await db.$queryRaw<
    Array<{ label: string; value: bigint }>
  >`
    SELECT
      COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS label,
      COUNT(*)::bigint AS value
    FROM "Item"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status IN ('low_stock', 'out_of_stock')
    GROUP BY 1
    ORDER BY value DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    label: row.label,
    value: Number(row.value),
  }));
}

/** Aliases used by stockReports consumers. */
export const stockValueByCategory = itemsByCategoryValue;
export const stockMovementTrend = movementTrend;

export async function lowStockItems(
  db: TenantScopedPrisma,
  tenantId: string,
  limit = 50,
): Promise<StockItemRow[]> {
  const rows = await db.item.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: { in: ['low_stock', 'out_of_stock'] },
    },
    select: {
      id: true,
      sku: true,
      name: true,
      category: true,
      quantity: true,
      reorderPoint: true,
      costPrice: true,
      status: true,
      currency: true,
    },
    orderBy: [{ quantity: 'asc' }, { name: 'asc' }],
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    reorderPoint: row.reorderPoint,
    costPrice: toNumber(row.costPrice),
    status: row.status,
    currency: row.currency,
  }));
}

/** Highest-value SKUs for Stock Report valuation table. */
export async function topStockValueItems(
  db: TenantScopedPrisma,
  tenantId: string,
  limit = 50,
): Promise<StockItemRow[]> {
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      sku: string;
      name: string;
      category: string | null;
      quantity: number;
      reorderPoint: number | null;
      costPrice: Prisma.Decimal;
      status: string;
      currency: string;
    }>
  >`
    SELECT
      id,
      sku,
      name,
      category,
      quantity,
      "reorderPoint",
      "costPrice",
      status::text AS status,
      currency
    FROM "Item"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
    ORDER BY (quantity * "costPrice") DESC, name ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    reorderPoint: row.reorderPoint,
    costPrice: toNumber(row.costPrice),
    status: row.status,
    currency: row.currency,
  }));
}
