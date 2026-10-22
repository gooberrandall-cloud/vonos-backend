/**
 * Audit duplicate Item rows on a tenant (default VP).
 * Usage: TENANTS=VP npx tsx prisma/scripts/audit-item-duplicates.ts
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';

function loadDotEnv(path: string): void {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
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
  } catch {
    /* ignore */
  }
}

loadDotEnv(resolve(__dirname, '../../.env'));

const prisma = new PrismaClient();
const codes = (process.env.TENANTS ?? 'VP')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

async function audit(code: string) {
  const tenant = await prisma.tenant.findFirst({
    where: { code, deletedAt: null },
  });
  if (!tenant) {
    console.log(`${code}: tenant not found`);
    return;
  }

  const total = await prisma.item.count({
    where: { tenantId: tenant.id, deletedAt: null },
  });

  const skuDups = await prisma.$queryRawUnsafe<
    Array<{ k: string; c: number }>
  >(
    `
    SELECT UPPER(TRIM(regexp_replace(sku, '[[:space:]]+', ' ', 'g'))) AS k,
           COUNT(*)::int AS c
    FROM "Item"
    WHERE "tenantId" = $1 AND "deletedAt" IS NULL
    GROUP BY 1
    HAVING COUNT(*) > 1
    ORDER BY c DESC
    LIMIT 40
    `,
    tenant.id,
  );

  const nameDups = await prisma.$queryRawUnsafe<
    Array<{ k: string; c: number; skus: string[]; qtys: number[] }>
  >(
    `
    SELECT UPPER(TRIM(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) AS k,
           COUNT(*)::int AS c,
           array_agg(sku ORDER BY quantity DESC, "createdAt" DESC) AS skus,
           array_agg(quantity::float8 ORDER BY quantity DESC, "createdAt" DESC) AS qtys
    FROM "Item"
    WHERE "tenantId" = $1 AND "deletedAt" IS NULL
    GROUP BY 1
    HAVING COUNT(*) > 1
    ORDER BY c DESC
    LIMIT 40
    `,
    tenant.id,
  );

  const nameAsSkuClones = await prisma.$queryRawUnsafe<
    Array<{ name: string; c: number }>
  >(
    `
    SELECT UPPER(TRIM(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) AS name,
           COUNT(*)::int AS c
    FROM "Item"
    WHERE "tenantId" = $1
      AND "deletedAt" IS NULL
      AND (
        UPPER(TRIM(regexp_replace(sku, '[[:space:]]+', ' ', 'g')))
          = UPPER(TRIM(regexp_replace(name, '[[:space:]]+', ' ', 'g')))
        OR sku ILIKE 'Vonos auto-%'
      )
    GROUP BY 1
    HAVING COUNT(*) > 1
    ORDER BY c DESC
    LIMIT 40
    `,
    tenant.id,
  );

  const extraSku = skuDups.reduce((n, r) => n + (r.c - 1), 0);
  const extraName = nameDups.reduce((n, r) => n + (r.c - 1), 0);

  console.log(`\n=== ${code} (${tenant.id}) ===`);
  console.log(`active items: ${total}`);
  console.log(
    `exact SKU dup groups: ${skuDups.length} (extra rows: ${extraSku})`,
  );
  for (const row of skuDups.slice(0, 15)) {
    console.log(`  SKU×${row.c}: ${row.k}`);
  }
  console.log(
    `exact name dup groups: ${nameDups.length} (extra rows: ${extraName})`,
  );
  for (const row of nameDups.slice(0, 20)) {
    console.log(
      `  NAME×${row.c}: ${row.k} | skus=${row.skus.slice(0, 4).join(' || ')}`,
    );
  }
  console.log(
    `name↔sku / Vonos-auto clone groups: ${nameAsSkuClones.length}`,
  );
  for (const row of nameAsSkuClones.slice(0, 15)) {
    console.log(`  CLONE×${row.c}: ${row.name}`);
  }
}

async function main() {
  for (const code of codes) {
    await audit(code);
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
