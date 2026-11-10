/**
 * Rebuild TenantDailyFinance from LedgerEntry (all tenants or one).
 * Usage (from apps/api):
 *   npx tsx prisma/scripts/backfill-daily-finance.ts
 *   npx tsx prisma/scripts/backfill-daily-finance.ts tenant_va_001
 */
import { PrismaClient } from '@prisma/client';
import { backfillDailyFinanceFromLedger } from '../../src/common/utils/dailyFinanceRollup';

async function main() {
  const prisma = new PrismaClient();
  const tenantId = process.argv[2];
  console.log(
    tenantId
      ? `Backfilling TenantDailyFinance for ${tenantId}…`
      : 'Backfilling TenantDailyFinance for all tenants…',
  );
  const rows = await backfillDailyFinanceFromLedger(
    prisma as unknown as Parameters<typeof backfillDailyFinanceFromLedger>[0],
    tenantId,
  );
  console.log(`Done: ${rows} day-rows upserted.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
