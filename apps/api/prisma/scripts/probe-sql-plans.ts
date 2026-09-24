import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

async function connect() {
  const env = readFileSync(join(__dirname, '../../.env'), 'utf8');
  const raw = env
    .match(/^DATABASE_URL=(.+)$/m)?.[1]
    ?.replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('no DATABASE_URL');
  const withParams = (url: string) => {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}connection_limit=1&pool_timeout=60&sslmode=require`;
  };
  const direct = raw.replace('-pooler.', '.');
  for (const url of [withParams(direct), withParams(raw)]) {
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

async function main() {
  const p = await connect();
  try {
    const sql = `SELECT p.id FROM "Payment" p
      WHERE p."tenantId"='tenant_va_001' AND p."deletedAt" IS NULL
      ORDER BY p."paidOn" DESC NULLS LAST, p.id DESC LIMIT 26`;
    const plan = await p.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
    );
    console.log(plan.map((r) => r['QUERY PLAN']).join('\n'));

    const jobSql = `SELECT AVG(GREATEST(0, EXTRACT(EPOCH FROM (j."updatedAt" - j."createdAt")) / 86400.0)) AS avg_days
      FROM "Job" j
      WHERE j."tenantId" = 'tenant_va_001' AND j."deletedAt" IS NULL
        AND j.status = 'Delivered'
        AND j."createdAt" >= NOW() - INTERVAL '30 days'
        AND j."createdAt" <= NOW()`;
    const jobPlan = await p.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${jobSql}`,
    );
    console.log('\n--- jobs.avgTurnaround ---\n');
    console.log(jobPlan.map((r) => r['QUERY PLAN']).join('\n'));

    const counts = await p.$queryRawUnsafe<
      Array<Record<string, bigint | number>>
    >(`SELECT
      (SELECT COUNT(*) FROM "Payment" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL) AS payments,
      (SELECT COUNT(*) FROM "LedgerEntry" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL) AS ledger,
      (SELECT COUNT(*) FROM "Sale" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL) AS sales,
      (SELECT COUNT(*) FROM "Job" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL) AS jobs,
      (SELECT COUNT(*) FROM "Job" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL AND status='Delivered') AS jobs_delivered,
      (SELECT COUNT(*) FROM "TenantDailyFinance" WHERE "tenantId"='tenant_va_001') AS rollup`);
    console.log(
      '\nCOUNTS',
      JSON.stringify(
        counts,
        (_k, v) => (typeof v === 'bigint' ? Number(v) : v),
        2,
      ),
    );
  } finally {
    await p.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
