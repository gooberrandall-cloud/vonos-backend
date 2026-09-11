/**
 * Soft-delete junk catalog rows whose costPrice looks like a migrated
 * Ultimate POS profit % (e.g. 11.11, 25) and sellPrice is missing — but only
 * when a properly priced sibling exists in the same tenant (safe).
 *
 * Sibling match (any of):
 *   - same normalized SKU
 *   - same normalized display name
 *   - same sorted name tokens ("AOSADO OIL 5L" ↔ "5L AOSADO OIL")
 *
 * Usage (from apps/api):
 *   npm run prisma:soft-delete-bad-prices
 *   TENANTS=VP,VA,VISP,VSP npm run prisma:soft-delete-bad-prices
 *   TENANTS=VP,VA npm run prisma:soft-delete-bad-prices -- --execute
 *
 * Dry-run by default. Pass --execute to soft-delete.
 * Qty of dropped rows is merged onto the keeper first.
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

/** Cost below this + no sell price ⇒ candidate junk (profit % / bad import). */
const BAD_COST_MAX = 100;

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

type Pair = {
  bad_id: string;
  bad_name: string;
  bad_sku: string;
  bad_cost: number;
  bad_qty: number;
  keeper_id: string;
  keeper_sku: string;
  keeper_cost: number;
  keeper_sell: number | null;
};

async function loadPairs(tenantId: string): Promise<Pair[]> {
  return prisma.$queryRawUnsafe<Pair[]>(
    `
    WITH base AS (
      SELECT
        id,
        name,
        sku,
        quantity,
        "costPrice",
        "sellPrice",
        "createdAt",
        UPPER(TRIM(regexp_replace(sku, '[[:space:]]+', ' ', 'g'))) AS sku_key,
        UPPER(TRIM(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) AS name_key,
        (
          SELECT string_agg(tok, ' ' ORDER BY tok)
          FROM unnest(
            regexp_split_to_array(
              UPPER(TRIM(regexp_replace(name, '[[:space:]]+', ' ', 'g'))),
              ' '
            )
          ) AS tok
          WHERE tok <> ''
        ) AS token_key
      FROM "Item"
      WHERE "tenantId" = $1
        AND "deletedAt" IS NULL
    )
    SELECT
      b.id AS bad_id,
      b.name AS bad_name,
      b.sku AS bad_sku,
      b."costPrice"::float AS bad_cost,
      b.quantity::float AS bad_qty,
      k.id AS keeper_id,
      k.sku AS keeper_sku,
      k."costPrice"::float AS keeper_cost,
      k."sellPrice"::float AS keeper_sell
    FROM base b
    JOIN LATERAL (
      SELECT i.id, i.sku, i."costPrice", i."sellPrice"
      FROM base i
      WHERE i.id <> b.id
        AND (
          i.sku_key = b.sku_key
          OR i.name_key = b.name_key
          OR (i.token_key IS NOT NULL AND i.token_key = b.token_key)
        )
        AND (
          i."costPrice" >= $2
          OR (i."sellPrice" IS NOT NULL AND i."sellPrice" >= $2)
        )
      ORDER BY
        COALESCE(i."sellPrice", 0) DESC,
        i."costPrice" DESC,
        i.quantity DESC,
        i."createdAt" DESC
      LIMIT 1
    ) k ON true
    WHERE b."costPrice" > 0
      AND b."costPrice" < $2
      AND (b."sellPrice" IS NULL OR b."sellPrice" = 0)
    ORDER BY b.name, b.sku
    `,
    tenantId,
    BAD_COST_MAX,
  );
}

async function softDeleteTenant(tenantId: string, code: string): Promise<void> {
  const pairs = await loadPairs(tenantId);
  const orphans = await prisma.$queryRawUnsafe<{ c: number }[]>(
    `
    WITH base AS (
      SELECT
        id,
        "costPrice",
        "sellPrice",
        UPPER(TRIM(regexp_replace(sku, '[[:space:]]+', ' ', 'g'))) AS sku_key,
        UPPER(TRIM(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) AS name_key,
        (
          SELECT string_agg(tok, ' ' ORDER BY tok)
          FROM unnest(
            regexp_split_to_array(
              UPPER(TRIM(regexp_replace(name, '[[:space:]]+', ' ', 'g'))),
              ' '
            )
          ) AS tok
          WHERE tok <> ''
        ) AS token_key
      FROM "Item"
      WHERE "tenantId" = $1
        AND "deletedAt" IS NULL
    )
    SELECT COUNT(*)::int AS c
    FROM base b
    WHERE b."costPrice" > 0
      AND b."costPrice" < $2
      AND (b."sellPrice" IS NULL OR b."sellPrice" = 0)
      AND NOT EXISTS (
        SELECT 1 FROM base i
        WHERE i.id <> b.id
          AND (
            i.sku_key = b.sku_key
            OR i.name_key = b.name_key
            OR (i.token_key IS NOT NULL AND i.token_key = b.token_key)
          )
          AND (
            i."costPrice" >= $2
            OR (i."sellPrice" IS NOT NULL AND i."sellPrice" >= $2)
          )
      )
    `,
    tenantId,
    BAD_COST_MAX,
  );

  console.log(
    `\n[${code}] bad-with-good-sibling=${pairs.length} orphans(left alone)=${orphans[0]?.c ?? 0}`,
  );
  for (const row of pairs.slice(0, 8)) {
    console.log(
      `  drop ${row.bad_sku} (₦${row.bad_cost}) → keep ${row.keeper_sku} (cost ₦${row.keeper_cost}, sell ₦${row.keeper_sell ?? 0})`,
    );
  }
  if (pairs.length > 8) console.log(`  … +${pairs.length - 8} more`);

  if (dryRun || pairs.length === 0) return;

  const byKeeper = new Map<string, { qty: number; badIds: string[] }>();
  for (const row of pairs) {
    const slot = byKeeper.get(row.keeper_id) ?? { qty: 0, badIds: [] };
    slot.qty += Number(row.bad_qty) || 0;
    slot.badIds.push(row.bad_id);
    byKeeper.set(row.keeper_id, slot);
  }

  for (const [keeperId, { qty }] of byKeeper) {
    if (qty === 0) continue;
    await prisma.item.update({
      where: { id: keeperId },
      data: { quantity: { increment: qty } },
    });
  }

  const badIds = pairs.map((p) => p.bad_id);
  const now = new Date();
  const result = await prisma.item.updateMany({
    where: { id: { in: badIds }, deletedAt: null },
    data: { deletedAt: now },
  });
  console.log(`  soft-deleted ${result.count}`);
}

async function main() {
  console.log(
    dryRun
      ? 'DRY RUN (pass --execute to soft-delete bad profit-% price clones)'
      : 'EXECUTE — merging qty onto keepers and soft-deleting bad clones',
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
    await softDeleteTenant(t.id, t.code);
  }

  if (dryRun) {
    console.log(
      '\nRe-run with --execute to apply. Orphans (no good sibling) are left for manual price fix.',
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
