/**
 * Backfill Job.customerId by matching Job.customerName to Customer.name (per tenant).
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/backfill-job-customer-id.ts
 *   npx ts-node ... backfill-job-customer-id.ts --dry-run
 *   npx ts-node ... backfill-job-customer-id.ts --tenant-id tenant_va_001
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant-id='));
const tenantFilter = tenantArg?.split('=')[1];

const matchWhere = Prisma.sql`
  j."deletedAt" IS NULL
  AND c."deletedAt" IS NULL
  AND j."customerId" IS NULL
  AND j."customerName" IS NOT NULL
  AND j."tenantId" = c."tenantId"
  AND lower(trim(j."customerName")) = lower(trim(c.name))
  ${tenantFilter ? Prisma.sql`AND j."tenantId" = ${tenantFilter}` : Prisma.empty}
`;

async function main() {
  const [{ count: matched }] = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(DISTINCT j.id)::bigint AS count
    FROM "Job" j
    INNER JOIN "Customer" c ON ${matchWhere}
  `;

  const [{ count: jobsScanned }] = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count
    FROM "Job" j
    WHERE j."deletedAt" IS NULL
      AND j."customerId" IS NULL
      AND j."customerName" IS NOT NULL
      ${tenantFilter ? Prisma.sql`AND j."tenantId" = ${tenantFilter}` : Prisma.empty}
  `;

  const matchedNum = Number(matched);
  const scannedNum = Number(jobsScanned);

  if (!dryRun && matchedNum > 0) {
    const updated = await prisma.$executeRaw`
      UPDATE "Job" j
      SET "customerId" = c.id
      FROM "Customer" c
      WHERE ${matchWhere}
    `;
    console.log(`Updated ${updated} jobs.`);
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        tenantFilter: tenantFilter ?? 'all',
        jobsScanned: scannedNum,
        matched: matchedNum,
        unmatched: scannedNum - matchedNum,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
