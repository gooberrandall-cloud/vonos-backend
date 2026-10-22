/**
 * One-shot VA cleanup (bulk SQL):
 * 1) Soft-delete duplicate SKUs from double import (keep highest qty, then newest).
 * 2) Backfill Item.costPrice / sellPrice from most recent inbound unitCost.
 *
 * Prefer multi-tenant SKU dedupe: prisma/scripts/dedupe-items-by-sku.ts
 *
 * Usage: npx tsx prisma/scripts/dedupe-items-and-backfill-prices.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const va = await prisma.tenant.findFirst({
    where: { code: "VA" },
    select: { id: true },
  });
  if (!va) throw new Error("VA tenant not found");
  const tenantId = va.id;

  console.log("Merging quantities onto keepers…");
  const merged = await prisma.$executeRaw`
    WITH ranked AS (
      SELECT
        id,
        sku,
        quantity,
        ROW_NUMBER() OVER (
          PARTITION BY sku
          ORDER BY quantity DESC, "createdAt" DESC, id DESC
        ) AS rn
      FROM "Item"
      WHERE "tenantId" = ${tenantId}
        AND "deletedAt" IS NULL
    ),
    keepers AS (SELECT id, sku, quantity FROM ranked WHERE rn = 1),
    drop_sum AS (
      SELECT sku, SUM(quantity) AS drop_qty
      FROM ranked
      WHERE rn > 1
      GROUP BY sku
    )
    UPDATE "Item" AS i
    SET quantity = k.quantity + COALESCE(d.drop_qty, 0),
        "updatedAt" = NOW()
    FROM keepers k
    JOIN drop_sum d ON d.sku = k.sku
    WHERE i.id = k.id
      AND COALESCE(d.drop_qty, 0) <> 0
  `;
  console.log({ mergedRows: merged });

  console.log("Soft-deleting duplicate SKU rows…");
  const softDeleted = await prisma.$executeRaw`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY sku
          ORDER BY quantity DESC, "createdAt" DESC, id DESC
        ) AS rn
      FROM "Item"
      WHERE "tenantId" = ${tenantId}
        AND "deletedAt" IS NULL
    )
    UPDATE "Item" AS i
    SET "deletedAt" = NOW(),
        "updatedAt" = NOW()
    FROM ranked r
    WHERE i.id = r.id
      AND r.rn > 1
  `;
  console.log({ softDeleted });

  console.log("Building last-purchase unitCost map…");
  // Materialize latest unitCost per sku from inbound JSON lines.
  await prisma.$executeRaw`DROP TABLE IF EXISTS tmp_last_purchase_cost`;
  await prisma.$executeRaw`
    CREATE TEMP TABLE tmp_last_purchase_cost AS
    WITH exploded AS (
      SELECT
        UPPER(TRIM(elem->>'sku')) AS sku,
        NULLIF(TRIM(elem->>'itemId'), '') AS item_id,
        (elem->>'unitCost')::numeric AS unit_cost,
        sm.date AS purchase_date,
        sm."createdAt" AS purchase_created
      FROM "StockMovement" sm
      CROSS JOIN LATERAL jsonb_array_elements(sm.lines::jsonb) AS elem
      WHERE sm."tenantId" = ${tenantId}
        AND sm.type = 'inbound'
        AND sm."deletedAt" IS NULL
        AND elem->>'unitCost' IS NOT NULL
        AND (elem->>'unitCost') ~ '^-?[0-9]+(\\.[0-9]+)?$'
    ),
    ranked AS (
      SELECT
        sku,
        item_id,
        unit_cost,
        ROW_NUMBER() OVER (
          PARTITION BY sku
          ORDER BY purchase_date DESC, purchase_created DESC
        ) AS rn_sku,
        ROW_NUMBER() OVER (
          PARTITION BY item_id
          ORDER BY purchase_date DESC, purchase_created DESC
        ) AS rn_item
      FROM exploded
      WHERE unit_cost IS NOT NULL AND unit_cost >= 0
    )
    SELECT sku, item_id, unit_cost, rn_sku, rn_item FROM ranked
  `;

  console.log("Backfilling costPrice / sellPrice from last purchase…");
  const byItem = await prisma.$executeRaw`
    UPDATE "Item" AS i
    SET
      "costPrice" = t.unit_cost,
      "sellPrice" = COALESCE(i."sellPrice", t.unit_cost),
      "updatedAt" = NOW()
    FROM tmp_last_purchase_cost t
    WHERE i."tenantId" = ${tenantId}
      AND i."deletedAt" IS NULL
      AND t.item_id = i.id
      AND t.rn_item = 1
  `;
  const bySku = await prisma.$executeRaw`
    UPDATE "Item" AS i
    SET
      "costPrice" = t.unit_cost,
      "sellPrice" = COALESCE(i."sellPrice", t.unit_cost),
      "updatedAt" = NOW()
    FROM tmp_last_purchase_cost t
    WHERE i."tenantId" = ${tenantId}
      AND i."deletedAt" IS NULL
      AND UPPER(TRIM(i.sku)) = t.sku
      AND t.rn_sku = 1
      AND t.sku <> ''
      AND (
        i."costPrice" IS DISTINCT FROM t.unit_cost
        OR i."sellPrice" IS NULL
      )
  `;
  console.log({ updatedByItemId: byItem, updatedBySku: bySku });

  const remainingDup = await prisma.$queryRaw<Array<{ c: number }>>`
    SELECT COUNT(*)::int AS c FROM (
      SELECT sku FROM "Item"
      WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
      GROUP BY sku HAVING COUNT(*) > 1
    ) t
  `;
  const active = await prisma.item.count({
    where: { tenantId, deletedAt: null },
  });
  const sellNull = await prisma.item.count({
    where: { tenantId, deletedAt: null, sellPrice: null },
  });
  console.log({
    remainingDupGroups: remainingDup[0]?.c ?? 0,
    activeItems: active,
    sellPriceStillNull: sellNull,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
