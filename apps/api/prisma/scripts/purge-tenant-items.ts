/**
 * Soft-delete ALL active items (products/inventory SKUs) for selected tenants
 * (default: VS, VKW). Hard-deletes ItemLocationStock rows for those items.
 *
 * Does not touch sales, purchases, expenses, customers, or master-data categories.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/purge-tenant-items.ts
 *   npx ts-node --transpile-only prisma/scripts/purge-tenant-items.ts --execute
 *   TENANT_CODES=VS,VKW npx ts-node --transpile-only prisma/scripts/purge-tenant-items.ts --execute
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');

const DEFAULT_CODES = ['VS', 'VKW'] as const;
const codes = (process.env.TENANT_CODES ?? DEFAULT_CODES.join(','))
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

const BATCH = 150;

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        /closed the connection|Can't reach database|P1017|P1001|timed out/i.test(
          msg,
        );
      console.warn(`  retry ${i}/${attempts} ${label}: ${msg.slice(0, 120)}`);
      if (!retryable || i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 800 * i));
      try {
        await prisma.$connect();
      } catch {
        /* ignore */
      }
    }
  }
  throw last;
}

async function chunkedIds(
  fetchPage: (cursor: string | undefined) => Promise<Array<{ id: string }>>,
): Promise<string[]> {
  const all: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    if (page.length === 0) break;
    for (const row of page) all.push(row.id);
    if (page.length < BATCH) break;
    cursor = page[page.length - 1]!.id;
  }
  return all;
}

async function main() {
  if (codes.length === 0) {
    console.error('No TENANT_CODES provided');
    process.exit(1);
  }

  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, code: { in: codes } },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });

  if (tenants.length === 0) {
    console.error(`No tenants found for: ${codes.join(', ')}`);
    process.exit(1);
  }

  const missing = codes.filter((c) => !tenants.some((t) => t.code === c));
  if (missing.length) {
    console.warn(`Missing tenants (skipped): ${missing.join(', ')}`);
  }

  console.log(
    dryRun
      ? 'DRY-RUN — pass --execute to soft-delete items'
      : 'EXECUTE — soft-deleting all items for selected tenants',
  );
  console.log(`Tenants: ${tenants.map((t) => t.code).join(', ')}`);
  console.log('');

  const now = new Date();
  let totalItems = 0;
  let totalLocStock = 0;

  for (const tenant of tenants) {
    const itemWhere = { tenantId: tenant.id, deletedAt: null as null };

    const [items, locStock, sumQty, sumValue] = await Promise.all([
      prisma.item.count({ where: itemWhere }),
      prisma.itemLocationStock.count({ where: { tenantId: tenant.id } }),
      prisma.item.aggregate({
        where: itemWhere,
        _sum: { quantity: true },
      }),
      prisma.$queryRaw<[{ stock_value: unknown }]>`
        SELECT COALESCE(SUM(quantity * "costPrice"), 0) AS stock_value
        FROM "Item"
        WHERE "tenantId" = ${tenant.id} AND "deletedAt" IS NULL
      `,
    ]);

    totalItems += items;
    totalLocStock += locStock;
    const stockValue = Number(sumValue[0]?.stock_value ?? 0);

    console.log(`[${tenant.code}] ${tenant.name}`);
    console.log(
      `  items=${items} locationStock=${locStock} totalQty=${sumQty._sum.quantity ?? 0} stockValue=${stockValue}`,
    );

    if (dryRun || items === 0) {
      if (!dryRun && items === 0) console.log('  already empty');
      continue;
    }

    const itemIds = await chunkedIds((cursor) =>
      prisma.item.findMany({
        where: itemWhere,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );

    for (let i = 0; i < itemIds.length; i += BATCH) {
      const batch = itemIds.slice(i, i + BATCH);
      await withRetry(`itemLocationStock delete ${batch.length}`, () =>
        prisma.itemLocationStock.deleteMany({
          where: { tenantId: tenant.id, itemId: { in: batch } },
        }),
      );
      await withRetry(`item soft-delete ${batch.length}`, () =>
        prisma.item.updateMany({
          where: { id: { in: batch }, deletedAt: null },
          data: { deletedAt: now, quantity: 0 },
        }),
      );
    }

    const remaining = await prisma.item.count({ where: itemWhere });
    const remainingLoc = await prisma.itemLocationStock.count({
      where: { tenantId: tenant.id },
    });
    console.log(
      `  done — remaining active items=${remaining} locationStock=${remainingLoc}`,
    );
  }

  console.log('');
  console.log(
    dryRun
      ? `Dry-run complete. Would soft-delete items=${totalItems}, locationStock rows=${totalLocStock}.`
      : `Execute complete. Soft-deleted items=${totalItems}, removed locationStock rows=${totalLocStock}.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
