import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import {
  fetchCustomerFtsIds,
  fetchItemFtsIds,
  shouldUseFtsListSearch,
} from '../../src/common/utils/listSearch';

const VA = 'tenant_va_001';

async function connect(): Promise<PrismaClient> {
  const env = readFileSync(join(__dirname, '../../.env'), 'utf8');
  const raw = env
    .match(/^DATABASE_URL=(.+)$/m)?.[1]
    ?.replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('DATABASE_URL missing');

  const candidates = [raw.replace('-pooler.', '.'), raw];
  const errors: string[] = [];
  for (const base of candidates) {
    const sep = base.includes('?') ? '&' : '?';
    const url = `${base}${sep}connection_limit=1&pool_timeout=60&sslmode=require`;
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      return prisma;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      await prisma.$disconnect().catch(() => undefined);
    }
  }
  throw new Error(`connect failed: ${errors.join(' | ')}`);
}

async function main() {
  const prisma = await connect();
  const results: Array<Record<string, unknown>> = [];

  try {
    const counts = await prisma.$queryRawUnsafe<
      Array<{ items: number; customers: number }>
    >(
      `SELECT
        (SELECT COUNT(*)::int FROM "Item"
          WHERE "tenantId" = $1 AND "deletedAt" IS NULL AND "searchVector" IS NOT NULL) AS items,
        (SELECT COUNT(*)::int FROM "Customer"
          WHERE "tenantId" = $1 AND "deletedAt" IS NULL AND "searchVector" IS NOT NULL) AS customers`,
      VA,
    );
    results.push({
      check: 'searchVector populated',
      ...counts[0],
      pass: Number(counts[0]?.items ?? 0) > 0,
    });

    const sample = await prisma.$queryRawUnsafe<
      Array<{ name: string; sku: string }>
    >(
      `SELECT name, sku FROM "Item"
       WHERE "tenantId" = $1 AND "deletedAt" IS NULL AND name ~ '\\s'
       ORDER BY length(name) DESC LIMIT 3`,
      VA,
    );
    const phrase =
      sample[0]?.name
        ?.split(/\s+/)
        .filter((t) => t.length >= 2)
        .slice(0, 2)
        .join(' ') ?? '';

    results.push({
      check: 'router multi-word',
      phrase,
      pass: phrase.length > 0 && shouldUseFtsListSearch(phrase),
    });
    results.push({
      check: 'router single token off FTS',
      pass: shouldUseFtsListSearch('Camry') === false,
    });

    const t0 = performance.now();
    const itemIds = await fetchItemFtsIds(prisma, VA, phrase);
    const itemMs = Math.round((performance.now() - t0) * 100) / 100;
    const top =
      itemIds.length === 0
        ? []
        : await prisma.item.findMany({
            where: { id: { in: itemIds.slice(0, 5) } },
            select: { name: true, sku: true },
          });

    results.push({
      check: 'item FTS hits',
      phrase,
      hits: itemIds.length,
      wallMs: itemMs,
      top,
      pass: itemIds.length > 0,
    });

    const plan = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT id FROM "Item"
       WHERE "tenantId" = $1 AND "deletedAt" IS NULL
         AND "searchVector" @@ plainto_tsquery('simple', $2)
       LIMIT 26`,
      VA,
      phrase,
    );
    const planText = plan.map((r) => r['QUERY PLAN']).join('\n');
    results.push({
      check: 'item FTS plan',
      explainMs: Number(planText.match(/Execution Time:\s*([\d.]+)/)?.[1] ?? 0),
      usesGin: /searchVector|Bitmap Index/i.test(planText),
      pass: /searchVector|Bitmap Index/i.test(planText),
    });

    const custSample = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM "Customer"
       WHERE "tenantId" = $1 AND "deletedAt" IS NULL AND name ~ '\\s'
       ORDER BY length(name) DESC LIMIT 1`,
      VA,
    );
    const custPhrase =
      custSample[0]?.name
        ?.split(/\s+/)
        .filter((t) => t.length >= 2)
        .slice(0, 2)
        .join(' ') ?? '';
    if (custPhrase) {
      const t1 = performance.now();
      const custIds = await fetchCustomerFtsIds(prisma, VA, custPhrase);
      results.push({
        check: 'customer FTS hits',
        phrase: custPhrase,
        hits: custIds.length,
        wallMs: Math.round((performance.now() - t1) * 100) / 100,
        pass: custIds.length > 0,
      });
    }

    const failed = results.filter((r) => r.pass === false);
    console.log(
      JSON.stringify(
        {
          ok: failed.length === 0,
          failed: failed.map((r) => r.check),
          results,
        },
        null,
        2,
      ),
    );
    if (failed.length > 0) process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
