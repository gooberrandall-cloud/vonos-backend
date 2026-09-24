/**
 * Soft-delete duplicate Item rows that share the same SKU within a tenant
 * (case-insensitive, whitespace-normalized — tabs/newlines collapse to spaces).
 * Merges quantity onto the keeper first.
 *
 * Keeper preference: highest quantity, then priced row, then newest createdAt.
 *
 * Usage (from apps/api):
 *   npx tsx prisma/scripts/dedupe-items-by-sku.ts
 *   npx tsx prisma/scripts/dedupe-items-by-sku.ts --execute
 *   TENANTS=VW,VA,VSP,VISP,VP npx tsx prisma/scripts/dedupe-items-by-sku.ts --execute
 *
 * Does not merge distinct SKUs that share a display name.
 * Price backfill remains in dedupe-items-and-backfill-prices.ts (VA-oriented).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';

loadDotEnv(resolve(__dirname, '../../.env'));

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');
const tenantFilter = (process.env.TENANTS ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

type DupGroup = {
  skuKey: string;
  cnt: bigint;
  keeperId: string;
  dropIds: string[];
  keeperQty: number;
  dropQty: number;
};

function loadDotEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const SKU_KEY_SQL = `UPPER(TRIM(regexp_replace(sku, '[[:space:]]+', ' ', 'g')))`;
const KEEPER_ORDER_SQL = `quantity DESC, CASE WHEN "sellPrice" IS NULL THEN 0 ELSE 1 END DESC, "createdAt" DESC, id DESC`;

async function loadDupGroups(tenantId: string): Promise<DupGroup[]> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      sku_key: string;
      id: string;
      quantity: number;
      rn: bigint;
      drop_qty: number;
      cnt: bigint;
    }>
  >(
    `
    WITH ranked AS (
      SELECT
        id,
        quantity,
        ${SKU_KEY_SQL} AS sku_key,
        ROW_NUMBER() OVER (
          PARTITION BY ${SKU_KEY_SQL}
          ORDER BY ${KEEPER_ORDER_SQL}
        ) AS rn,
        COUNT(*) OVER (PARTITION BY ${SKU_KEY_SQL}) AS cnt
      FROM "Item"
      WHERE "tenantId" = $1
        AND "deletedAt" IS NULL
        AND TRIM(sku) <> ''
    ),
    drop_sum AS (
      SELECT sku_key, SUM(quantity)::float8 AS drop_qty
      FROM ranked
      WHERE rn > 1
      GROUP BY sku_key
    )
    SELECT
      r.sku_key,
      r.id,
      r.quantity::float8 AS quantity,
      r.rn,
      COALESCE(d.drop_qty, 0)::float8 AS drop_qty,
      r.cnt
    FROM ranked r
    LEFT JOIN drop_sum d ON d.sku_key = r.sku_key
    WHERE r.cnt > 1
    ORDER BY r.sku_key, r.rn
    `,
    tenantId,
  );

  const bySku = new Map<string, DupGroup>();
  for (const row of rows) {
    let g = bySku.get(row.sku_key);
    if (!g) {
      g = {
        skuKey: row.sku_key,
        cnt: row.cnt,
        keeperId: '',
        dropIds: [],
        keeperQty: 0,
        dropQty: Number(row.drop_qty),
      };
      bySku.set(row.sku_key, g);
    }
    if (Number(row.rn) === 1) {
      g.keeperId = row.id;
      g.keeperQty = Number(row.quantity);
    } else {
      g.dropIds.push(row.id);
    }
  }
  return [...bySku.values()].filter((g) => g.keeperId && g.dropIds.length > 0);
}

async function dedupeTenant(tenantId: string, code: string): Promise<void> {
  const groups = await loadDupGroups(tenantId);
  const extraRows = groups.reduce((n, g) => n + g.dropIds.length, 0);
  console.log(
    `\n${code}: ${groups.length} duplicate SKU group(s), ${extraRows} extra row(s)`,
  );
  if (groups.length === 0) return;

  for (const g of groups.slice(0, 8)) {
    console.log(
      `  ${g.skuKey}: keep ${g.keeperId.slice(0, 12)}… qty ${g.keeperQty}` +
        (g.dropQty ? ` +merge ${g.dropQty}` : '') +
        ` → drop ${g.dropIds.length}`,
    );
  }
  if (groups.length > 8) {
    console.log(`  … +${groups.length - 8} more groups`);
  }

  if (dryRun) return;

  const merged = await prisma.$executeRawUnsafe(
    `
    WITH ranked AS (
      SELECT
        id,
        quantity,
        ${SKU_KEY_SQL} AS sku_key,
        ROW_NUMBER() OVER (
          PARTITION BY ${SKU_KEY_SQL}
          ORDER BY ${KEEPER_ORDER_SQL}
        ) AS rn
      FROM "Item"
      WHERE "tenantId" = $1
        AND "deletedAt" IS NULL
        AND TRIM(sku) <> ''
    ),
    keepers AS (SELECT id, sku_key, quantity FROM ranked WHERE rn = 1),
    drop_sum AS (
      SELECT sku_key, SUM(quantity) AS drop_qty
      FROM ranked
      WHERE rn > 1
      GROUP BY sku_key
    )
    UPDATE "Item" AS i
    SET quantity = k.quantity + COALESCE(d.drop_qty, 0),
        "updatedAt" = NOW()
    FROM keepers k
    JOIN drop_sum d ON d.sku_key = k.sku_key
    WHERE i.id = k.id
      AND COALESCE(d.drop_qty, 0) <> 0
    `,
    tenantId,
  );

  const softDeleted = await prisma.$executeRawUnsafe(
    `
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY ${SKU_KEY_SQL}
          ORDER BY ${KEEPER_ORDER_SQL}
        ) AS rn
      FROM "Item"
      WHERE "tenantId" = $1
        AND "deletedAt" IS NULL
        AND TRIM(sku) <> ''
    )
    UPDATE "Item" AS i
    SET "deletedAt" = NOW(),
        "updatedAt" = NOW()
    FROM ranked r
    WHERE i.id = r.id
      AND r.rn > 1
    `,
    tenantId,
  );

  const remaining = await prisma.$queryRawUnsafe<{ c: number }[]>(
    `
    SELECT COUNT(*)::int AS c FROM (
      SELECT ${SKU_KEY_SQL} AS sku_key
      FROM "Item"
      WHERE "tenantId" = $1 AND "deletedAt" IS NULL AND TRIM(sku) <> ''
      GROUP BY ${SKU_KEY_SQL}
      HAVING COUNT(*) > 1
    ) t
    `,
    tenantId,
  );

  const active = await prisma.item.count({
    where: { tenantId, deletedAt: null },
  });

  console.log({
    code,
    qtyMergedRows: merged,
    softDeleted,
    remainingDupGroups: remaining[0]?.c ?? 0,
    activeItems: active,
  });
}

async function main() {
  console.log(
    dryRun
      ? 'DRY RUN (pass --execute to soft-delete duplicates)'
      : 'EXECUTE — merging qty and soft-deleting duplicate SKUs',
  );

  const tenants = await prisma.tenant.findMany({
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });

  const selected = tenantFilter.length
    ? tenants.filter((t) => tenantFilter.includes(t.code.toUpperCase()))
    : tenants;

  if (selected.length === 0) {
    throw new Error(
      tenantFilter.length
        ? `No tenants matched TENANTS=${tenantFilter.join(',')}`
        : 'No tenants found',
    );
  }

  for (const t of selected) {
    await dedupeTenant(t.id, t.code);
  }

  if (dryRun) {
    console.log(
      '\nRe-run with --execute to apply. Each tenant (VA/VP/VW/VISP/VSP) has its own catalog — pass TENANTS=VISP,VSP,VP to clean retail clones.',
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
