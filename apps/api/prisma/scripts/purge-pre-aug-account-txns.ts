/**
 * Soft-delete AccountTransaction rows dated before Aug 2026 (Lagos),
 * plus any active book rows still linked to soft-deleted payments.
 *
 * Fixes negative balances from SQL-imported historical payments/movements
 * after Payment rows were purged but the account book was not.
 *
 *   npx ts-node --transpile-only prisma/scripts/purge-pre-aug-account-txns.ts
 *   npx ts-node --transpile-only prisma/scripts/purge-pre-aug-account-txns.ts --execute
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');
const onlyCode = (process.env.TENANT_CODE ?? '').trim().toUpperCase();
const CUTOFF = new Date('2026-08-01T00:00:00+01:00');
const OPERATING = [
  'VA',
  'VW',
  'VISP',
  'VSP',
  'VP',
  'VC',
  'VS',
  'VKW',
] as const;

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      code: onlyCode ? onlyCode : { in: [...OPERATING] },
    },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });

  console.log(
    dryRun
      ? 'DRY-RUN — pass --execute to apply'
      : 'EXECUTE — soft-deleting pre-Aug account book + orphan txns',
  );
  console.log(`Cutoff: operationDate < ${CUTOFF.toISOString()}`);
  console.log('');

  const now = new Date();
  let totalPre = 0;
  let totalOrphan = 0;

  for (const tenant of tenants) {
    const preCount = await prisma.accountTransaction.count({
      where: {
        tenantId: tenant.id,
        deletedAt: null,
        operationDate: { lt: CUTOFF },
      },
    });

    const orphanIds = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT x.id
      FROM "AccountTransaction" x
      JOIN "Payment" p ON p.id = x."paymentId"
      WHERE x."tenantId" = ${tenant.id}
        AND x."deletedAt" IS NULL
        AND p."deletedAt" IS NOT NULL
    `;

    totalPre += preCount;
    totalOrphan += orphanIds.length;

    console.log(
      `[${tenant.code}] pre-Aug txns=${preCount} orphans(soft-deleted payment)=${orphanIds.length}`,
    );

    if (dryRun) continue;

    if (preCount > 0) {
      const r = await prisma.accountTransaction.updateMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          operationDate: { lt: CUTOFF },
        },
        data: { deletedAt: now },
      });
      console.log(`  soft-deleted pre-Aug: ${r.count}`);
    }

    if (orphanIds.length > 0) {
      const r = await prisma.accountTransaction.updateMany({
        where: {
          id: { in: orphanIds.map((row) => row.id) },
          deletedAt: null,
        },
        data: { deletedAt: now },
      });
      console.log(`  soft-deleted orphans: ${r.count}`);
    }

    console.log('  done');
  }

  console.log('');
  console.log(
    dryRun
      ? `Dry-run complete. Would purge pre-Aug=${totalPre} orphans=${totalOrphan}.`
      : `Execute complete. Purged pre-Aug=${totalPre} orphans=${totalOrphan}.`,
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
