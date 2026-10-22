/**
 * EXPLAIN list search: trigram vs FTS (read-only).
 * Usage: npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/bench-list-search.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const VA = 'tenant_va_001';

function loadUrls(): string[] {
  const env = readFileSync(join(__dirname, '../../.env'), 'utf8');
  const raw = env
    .match(/^DATABASE_URL=(.+)$/m)?.[1]
    ?.replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('DATABASE_URL missing');
  const withParams = (url: string) => {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}connection_limit=1&pool_timeout=60&sslmode=require`;
  };
  return [...new Set([withParams(raw.replace('-pooler.', '.')), withParams(raw)])];
}

async function connect() {
  for (const url of loadUrls()) {
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      return prisma;
    } catch {
      await prisma.$disconnect().catch(() => undefined);
    }
  }
  throw new Error('connect failed');
}

async function explain(prisma: PrismaClient, label: string, sql: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
  );
  const text = rows.map((r) => r['QUERY PLAN']).join('\n');
  const ms = Number(text.match(/Execution Time:\s*([\d.]+)/)?.[1] ?? 0);
  const gin = /Bitmap Index Scan|Index Scan using .*searchVector|gin_trgm|trgm/i.test(
    text,
  );
  const seq = /Seq Scan on/.test(text);
  console.log(
    JSON.stringify({
      label,
      explainMs: ms,
      usesIndexHint: gin,
      seqScan: seq,
      head: text.split('\n').slice(0, 8),
    }),
  );
}

async function main() {
  const prisma = await connect();
  try {
    await explain(
      prisma,
      'item.trigram.brake',
      `SELECT id FROM "Item"
       WHERE "tenantId"='${VA}' AND "deletedAt" IS NULL
         AND (name ILIKE '%brake%' OR sku ILIKE '%brake%' OR "carModel" ILIKE '%brake%')
       ORDER BY "updatedAt" DESC, id DESC LIMIT 26`,
    );
    await explain(
      prisma,
      'item.fts.brake_pad',
      `SELECT id FROM "Item"
       WHERE "tenantId"='${VA}' AND "deletedAt" IS NULL
         AND "searchVector" @@ plainto_tsquery('simple', 'brake pad')
       ORDER BY ts_rank_cd("searchVector", plainto_tsquery('simple', 'brake pad')) DESC, id DESC
       LIMIT 26`,
    );
    await explain(
      prisma,
      'customer.fts.two_words',
      `SELECT id FROM "Customer"
       WHERE "tenantId"='${VA}' AND "deletedAt" IS NULL
         AND "searchVector" @@ plainto_tsquery('simple', 'john doe')
       ORDER BY ts_rank_cd("searchVector", plainto_tsquery('simple', 'john doe')) DESC, id DESC
       LIMIT 26`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
