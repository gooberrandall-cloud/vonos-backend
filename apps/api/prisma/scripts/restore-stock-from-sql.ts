/**
 * Apply stock quantities extracted from Ultimate POS SQL
 * (scripts/restore_stock_from_sql.py → tmp/stock_restore_vw_visp_vsp.json)
 * onto VW / VISP / VSP Item + ItemLocationStock rows matched by SKU.
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' \
 *     prisma/scripts/restore-stock-from-sql.ts
 *   npx ts-node ... restore-stock-from-sql.ts --dry-run
 *   npx ts-node ... restore-stock-from-sql.ts --json ../../tmp/stock_restore_vw_visp_vsp.json
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { PrismaClient, StockStatus } from "@prisma/client";

const prisma = new PrismaClient();

const dryRun = process.argv.includes("--dry-run");
const jsonArgIdx = process.argv.indexOf("--json");
const jsonPath = resolve(
  jsonArgIdx >= 0 && process.argv[jsonArgIdx + 1]
    ? process.argv[jsonArgIdx + 1]!
    : "../../tmp/stock_restore_vw_visp_vsp.json",
);

type SkuStock = {
  sku: string;
  quantity: number;
  locations?: Record<string, number>;
};

type EntityPayload = {
  code: string;
  sourceDb: string;
  bySku: Record<string, SkuStock>;
};

type Payload = {
  entities: Record<string, EntityPayload>;
};

function computeStatus(qty: number, reorderPoint: number | null): StockStatus {
  if (qty <= 0) return StockStatus.out_of_stock;
  if (reorderPoint != null && qty <= reorderPoint) return StockStatus.low_stock;
  return StockStatus.in_stock;
}

async function applyEntity(code: string, entity: EntityPayload) {
  const tenant = await prisma.tenant.findFirst({
    where: { code, deletedAt: null },
    select: { id: true, code: true },
  });
  if (!tenant) {
    console.error(`Tenant ${code} not found — skip`);
    return;
  }

  const items = await prisma.item.findMany({
    where: { tenantId: tenant.id, deletedAt: null },
    select: {
      id: true,
      sku: true,
      quantity: true,
      reorderPoint: true,
      locationCode: true,
      binLocation: true,
    },
  });
  const bySku = new Map(
    items.map((row) => [row.sku.trim().toLowerCase(), row]),
  );

  let matched = 0;
  let updated = 0;
  let unchanged = 0;
  let missingInApp = 0;
  let totalQtyApplied = 0;

  const updates: Array<{
    id: string;
    quantity: number;
    status: StockStatus;
    locationCode: string;
    binLocation: string;
    locations: Record<string, number>;
  }> = [];

  for (const [sku, stock] of Object.entries(entity.bySku)) {
    const item = bySku.get(sku.trim().toLowerCase());
    if (!item) {
      missingInApp += 1;
      continue;
    }
    matched += 1;
    const quantity = Math.max(0, Math.round(Number(stock.quantity) || 0));
    totalQtyApplied += quantity;
    if (item.quantity === quantity) {
      unchanged += 1;
      continue;
    }
    const locationCode =
      item.locationCode?.trim() ||
      Object.keys(stock.locations ?? {})[0] ||
      code;
    updates.push({
      id: item.id,
      quantity,
      status: computeStatus(quantity, item.reorderPoint),
      locationCode,
      binLocation: item.binLocation?.trim() || "",
      locations: stock.locations ?? { [locationCode]: quantity },
    });
  }

  console.log(
    JSON.stringify(
      {
        code,
        tenantId: tenant.id,
        sourceDb: entity.sourceDb,
        dumpSkus: Object.keys(entity.bySku).length,
        appItems: items.length,
        matched,
        willUpdate: updates.length,
        unchanged,
        missingInApp,
        totalQtyApplied,
        dryRun,
      },
      null,
      2,
    ),
  );

  if (dryRun || updates.length === 0) return;

  // Bulk SQL for Item qty + sequential location replace (avoids pool exhaustion).
  const chunkSize = 100;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    const ids = chunk.map((row) => row.id);

    const valuesSql = chunk
      .map(
        (row) =>
          `('${row.id}', ${row.quantity}, '${row.status}'::"StockStatus")`,
      )
      .join(",\n");
    await prisma.$executeRawUnsafe(`
      UPDATE "Item" AS i
      SET quantity = v.qty, status = v.status, "updatedAt" = NOW()
      FROM (VALUES ${valuesSql}) AS v(id, qty, status)
      WHERE i.id = v.id
    `);

    await prisma.itemLocationStock.deleteMany({
      where: { itemId: { in: ids } },
    });

    const locationRows = chunk.flatMap((row) => {
      const locEntries = Object.entries(row.locations);
      const primary =
        locEntries.length > 0
          ? locEntries
          : ([[row.locationCode, row.quantity]] as [string, number][]);
      const byKey = new Map<
        string,
        {
          tenantId: string;
          itemId: string;
          locationCode: string;
          binLocation: string;
          quantity: number;
        }
      >();
      for (const [locationCode, qty] of primary) {
        const codeKey = String(locationCode || code).trim() || code;
        const key = `${row.id}\0${codeKey}\0${row.binLocation}`;
        const existing = byKey.get(key);
        const quantity = Math.max(0, Math.round(Number(qty) || 0));
        if (existing) {
          existing.quantity += quantity;
        } else {
          byKey.set(key, {
            tenantId: tenant.id,
            itemId: row.id,
            locationCode: codeKey,
            binLocation: row.binLocation,
            quantity,
          });
        }
      }
      return [...byKey.values()];
    });

    if (locationRows.length > 0) {
      await prisma.itemLocationStock.createMany({
        data: locationRows,
        skipDuplicates: true,
      });
    }

    updated += chunk.length;
    console.log(`  ${code}: applied ${updated}/${updates.length}`);
  }
}

async function main() {
  const payload = JSON.parse(readFileSync(jsonPath, "utf8")) as Payload;
  const codes = Object.keys(payload.entities);
  console.log(`Applying stock from ${jsonPath} → ${codes.join(", ")}`);
  for (const code of codes) {
    await applyEntity(code, payload.entities[code]!);
  }
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
