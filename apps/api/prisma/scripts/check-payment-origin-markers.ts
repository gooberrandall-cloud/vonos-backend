import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

async function main() {
  const types = await prisma.$queryRaw<
    Array<{ entityType: string; n: number }>
  >`
    SELECT "entityType", COUNT(*)::int AS n
    FROM "MigrationLegacyId"
    WHERE "entityType" ILIKE '%pay%'
       OR "entityType" ILIKE '%account%'
       OR "entityType" ILIKE '%txn%'
    GROUP BY "entityType"
    ORDER BY n DESC
  `;
  console.log('legacy entityTypes (pay/account/txn):', types);

  const paymentLegacy = await prisma.migrationLegacyId.count({
    where: { entityType: 'payment' },
  });
  console.log('entityType=payment:', paymentLegacy);

  const activeWithLegacy = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n
    FROM "Payment" p
    JOIN "MigrationLegacyId" m
      ON m."newId" = p.id AND m."entityType" = 'payment'
    WHERE p."deletedAt" IS NULL
  `;
  const activeTotal = await prisma.payment.count({ where: { deletedAt: null } });
  console.log('active payments:', activeTotal, 'with legacy map:', activeWithLegacy);

  const augTxn = await prisma.$queryRaw<
    Array<{ kind: string; n: number }>
  >`
    SELECT
      CASE
        WHEN x."subType" IS NULL THEN 'importish_null_subtype'
        WHEN x."subType" IN ('sale_payment','purchase_payment','expense','opening_balance','fund_transfer','deposit')
          THEN 'appish_' || x."subType"
        ELSE 'other_' || COALESCE(x."subType",'null')
      END AS kind,
      COUNT(*)::int AS n
    FROM "AccountTransaction" x
    WHERE x."deletedAt" IS NULL
      AND x."operationDate" >= '2026-07-31T23:00:00.000Z'
    GROUP BY 1
    ORDER BY n DESC
  `;
  console.log('Aug+ active book by kind:', augTxn);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
