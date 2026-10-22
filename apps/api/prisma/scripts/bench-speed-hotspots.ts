/**
 * Focused before/after timing for Chion speed rewrites (read-only).
 * Usage from apps/api:
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/bench-speed-hotspots.ts
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

async function explainMs(prisma: PrismaClient, sql: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
  );
  const text = rows.map((r) => r['QUERY PLAN']).join('\n');
  return Number(text.match(/Execution Time:\s*([\d.]+)/)?.[1] ?? 0);
}

async function wallMs(prisma: PrismaClient, sql: string): Promise<number> {
  const t0 = performance.now();
  await prisma.$queryRawUnsafe(sql);
  return Math.round((performance.now() - t0) * 100) / 100;
}

async function main() {
  const prisma = await connect();
  const to = new Date();
  const curFrom = new Date(to.getTime() - 30 * 86400000);
  const priorTo = new Date(curFrom);
  const priorFrom = new Date(curFrom.getTime() - 30 * 86400000);
  const f = (d: Date) => d.toISOString();

  const queries: Array<[string, string]> = [
    [
      'jobCost.pair.rewritten',
      `WITH jobs AS (
         SELECT id, "createdAt" FROM "Job"
         WHERE "tenantId"='${VA}' AND "deletedAt" IS NULL
           AND "createdAt" >= '${f(priorFrom)}' AND "createdAt" <= '${f(to)}'
       )
       SELECT
         (SELECT COUNT(*)::bigint FROM jobs WHERE "createdAt" >= '${f(curFrom)}' AND "createdAt" <= '${f(to)}') AS cur_job_count,
         (SELECT COUNT(*)::bigint FROM jobs WHERE "createdAt" >= '${f(priorFrom)}' AND "createdAt" <= '${f(priorTo)}') AS prior_job_count,
         (SELECT COALESCE(SUM(jm."totalCost"),0) FROM "JobMaterial" jm INNER JOIN jobs j ON j.id=jm."jobId"
           WHERE j."createdAt" >= '${f(curFrom)}' AND j."createdAt" <= '${f(to)}') AS cur_materials,
         (SELECT COALESCE(SUM(jl."totalCost"),0) FROM "JobLabour" jl INNER JOIN jobs j ON j.id=jl."jobId"
           WHERE j."createdAt" >= '${f(curFrom)}' AND j."createdAt" <= '${f(to)}') AS cur_labour,
         (SELECT COALESCE(SUM(jm."totalCost"),0) FROM "JobMaterial" jm INNER JOIN jobs j ON j.id=jm."jobId"
           WHERE j."createdAt" >= '${f(priorFrom)}' AND j."createdAt" <= '${f(priorTo)}') AS prior_materials,
         (SELECT COALESCE(SUM(jl."totalCost"),0) FROM "JobLabour" jl INNER JOIN jobs j ON j.id=jl."jobId"
           WHERE j."createdAt" >= '${f(priorFrom)}' AND j."createdAt" <= '${f(priorTo)}') AS prior_labour`,
    ],
    [
      'topProducts.rewritten',
      `WITH period_sales AS (
         SELECT id FROM "Sale"
         WHERE "tenantId"='${VA}' AND "deletedAt" IS NULL
           AND status::text <> 'draft'
           AND date >= '${f(curFrom)}' AND date <= '${f(to)}'
       )
       SELECT MAX(COALESCE(NULLIF(TRIM(sl.sku), ''), sl.name)) AS sku,
              COALESCE(SUM(sl.quantity),0) AS units,
              COALESCE(SUM(sl."lineTotal"),0) AS revenue
       FROM period_sales s
       INNER JOIN "SaleLine" sl ON sl."saleId" = s.id
       GROUP BY COALESCE(NULLIF(TRIM(sl.sku), ''), sl.name)
       ORDER BY units DESC, revenue DESC LIMIT 12`,
    ],
    [
      'salesKpi.pair',
      `SELECT
         COUNT(*) FILTER (WHERE date >= '${f(curFrom)}' AND date <= '${f(to)}')::bigint AS cur_count,
         COALESCE(SUM(total) FILTER (WHERE date >= '${f(curFrom)}' AND date <= '${f(to)}'),0) AS cur_revenue,
         COUNT(*) FILTER (WHERE date >= '${f(priorFrom)}' AND date <= '${f(priorTo)}')::bigint AS prior_count,
         COALESCE(SUM(total) FILTER (WHERE date >= '${f(priorFrom)}' AND date <= '${f(priorTo)}'),0) AS prior_revenue
       FROM "Sale"
       WHERE "tenantId"='${VA}' AND "deletedAt" IS NULL AND status::text <> 'draft'
         AND date >= '${f(priorFrom)}' AND date <= '${f(to)}'`,
    ],
  ];

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    const out = [];
    for (const [id, sql] of queries) {
      const explain = await explainMs(prisma, sql);
      const wall = await wallMs(prisma, sql);
      out.push({ id, explainMs: explain, wallMs: wall });
      console.error(`${id}: explain=${explain}ms wall=${wall}ms`);
    }
    console.log(JSON.stringify({ tenant: VA, results: out }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
