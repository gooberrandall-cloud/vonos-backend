/**
 * Compare VP vs VA catalogs for cloned / overlapping SKUs.
 * Usage: npx tsx prisma/scripts/audit-vp-va-catalog-overlap.ts
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

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: { code: { in: ['VA', 'VP'] }, deletedAt: null },
    select: { id: true, code: true },
  });
  const va = tenants.find((t) => t.code === 'VA');
  const vp = tenants.find((t) => t.code === 'VP');
  if (!va || !vp) throw new Error('VA/VP missing');

  const counts = await prisma.$queryRawUnsafe<
    Array<{ code: string; n: number }>
  >(
    `
    SELECT t.code, COUNT(i.id)::int AS n
    FROM "Tenant" t
    JOIN "Item" i ON i."tenantId" = t.id AND i."deletedAt" IS NULL
    WHERE t.code IN ('VA','VP')
    GROUP BY t.code
    `,
  );

  const overlap = await prisma.$queryRawUnsafe<
    Array<{ shared: number }>
  >(
    `
    WITH va AS (
      SELECT UPPER(TRIM(regexp_replace(sku, '[[:space:]]+', ' ', 'g'))) AS k
      FROM "Item" WHERE "tenantId" = $1 AND "deletedAt" IS NULL
    ),
    vp AS (
      SELECT UPPER(TRIM(regexp_replace(sku, '[[:space:]]+', ' ', 'g'))) AS k
      FROM "Item" WHERE "tenantId" = $2 AND "deletedAt" IS NULL
    )
    SELECT COUNT(*)::int AS shared
    FROM (SELECT DISTINCT k FROM va) a
    JOIN (SELECT DISTINCT k FROM vp) b ON a.k = b.k
    `,
    va.id,
    vp.id,
  );

  const nameOverlap = await prisma.$queryRawUnsafe<
    Array<{ shared: number }>
  >(
    `
    WITH va AS (
      SELECT UPPER(TRIM(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) AS k
      FROM "Item" WHERE "tenantId" = $1 AND "deletedAt" IS NULL
    ),
    vp AS (
      SELECT UPPER(TRIM(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) AS k
      FROM "Item" WHERE "tenantId" = $2 AND "deletedAt" IS NULL
    )
    SELECT COUNT(*)::int AS shared
    FROM (SELECT DISTINCT k FROM va) a
    JOIN (SELECT DISTINCT k FROM vp) b ON a.k = b.k
    `,
    va.id,
    vp.id,
  );

  const vpOnlyDupNames = await prisma.$queryRawUnsafe<
    Array<{ groups: number; extras: number }>
  >(
    `
    SELECT COUNT(*)::int AS groups,
           COALESCE(SUM(c - 1), 0)::int AS extras
    FROM (
      SELECT COUNT(*) AS c
      FROM "Item"
      WHERE "tenantId" = $1 AND "deletedAt" IS NULL
      GROUP BY UPPER(TRIM(regexp_replace(name, '[[:space:]]+', ' ', 'g')))
      HAVING COUNT(*) > 1
    ) x
    `,
    vp.id,
  );

  const recentDupCreates = await prisma.$queryRawUnsafe<
    Array<{ day: string; n: number }>
  >(
    `
    SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS n
    FROM "Item"
    WHERE "tenantId" = $1 AND "deletedAt" IS NULL
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 15
    `,
    vp.id,
  );

  console.log({ counts, skuOverlap: overlap, nameOverlap, vpOnlyDupNames, recentDupCreates });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
