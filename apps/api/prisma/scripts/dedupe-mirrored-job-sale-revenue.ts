/**
 * Soft-delete Job-linked revenue ledger rows that mirror a Sale-linked row
 * (same tenant, amount, calendar day, invoice ref after Sale/Job prefix).
 * Then rebuild TenantDailyFinance so VAG rollup KPIs stop double-counting.
 *
 * Usage: cd apps/api && node --import tsx prisma/scripts/dedupe-mirrored-job-sale-revenue.ts
 */
import { PrismaClient } from '@prisma/client';
import { backfillDailyFinanceFromLedger } from '../../src/common/utils/dailyFinanceRollup';

const prisma = new PrismaClient();

async function main() {
  const preview = await prisma.$queryRaw<Array<{ cnt: bigint; total: unknown }>>`
    SELECT COUNT(*)::bigint AS cnt, COALESCE(SUM(job.amount), 0) AS total
    FROM "LedgerEntry" job
    WHERE job."deletedAt" IS NULL
      AND job.type = 'revenue'
      AND job."linkedRecordType" = 'job'
      AND EXISTS (
        SELECT 1
        FROM "LedgerEntry" s
        WHERE s."tenantId" = job."tenantId"
          AND s."deletedAt" IS NULL
          AND s.type = 'revenue'
          AND s."linkedRecordType" = 'sale'
          AND s.amount = job.amount
          AND date_trunc('day', s.date AT TIME ZONE 'UTC')
            = date_trunc('day', job.date AT TIME ZONE 'UTC')
          AND lower(regexp_replace(COALESCE(s.description, ''), '^sale\\s+', '', 'i'))
            = lower(regexp_replace(COALESCE(job.description, ''), '^job\\s+', '', 'i'))
      )
  `;

  const count = Number(preview[0]?.cnt ?? 0);
  const total = Number(preview[0]?.total ?? 0);
  console.log(`Mirrored Job revenue rows to soft-delete: ${count} (₦${total.toLocaleString()})`);

  if (count === 0) {
    console.log('Nothing to soft-delete; rebuilding rollup anyway…');
  } else {
    const deleted = await prisma.$executeRaw`
      UPDATE "LedgerEntry" AS job
      SET "deletedAt" = NOW()
      WHERE job."deletedAt" IS NULL
        AND job.type = 'revenue'
        AND job."linkedRecordType" = 'job'
        AND EXISTS (
          SELECT 1
          FROM "LedgerEntry" s
          WHERE s."tenantId" = job."tenantId"
            AND s."deletedAt" IS NULL
            AND s.type = 'revenue'
            AND s."linkedRecordType" = 'sale'
            AND s.amount = job.amount
            AND date_trunc('day', s.date AT TIME ZONE 'UTC')
              = date_trunc('day', job.date AT TIME ZONE 'UTC')
            AND lower(regexp_replace(COALESCE(s.description, ''), '^sale\\s+', '', 'i'))
              = lower(regexp_replace(COALESCE(job.description, ''), '^job\\s+', '', 'i'))
        )
    `;
    console.log(`Soft-deleted ${Number(deleted)} ledger rows`);
  }

  const rollupRows = await backfillDailyFinanceFromLedger(
    prisma as unknown as Parameters<typeof backfillDailyFinanceFromLedger>[0],
  );
  console.log(`Rebuilt TenantDailyFinance: ${rollupRows} day-tenant rows`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    void prisma.$disconnect();
    process.exit(1);
  });
