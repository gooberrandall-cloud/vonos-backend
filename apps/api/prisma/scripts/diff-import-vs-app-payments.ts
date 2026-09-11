import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$connect();

  const active = await prisma.payment.count({ where: { deletedAt: null } });
  const withLegacy = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n
    FROM "Payment" p
    INNER JOIN "MigrationLegacyId" m
      ON m."newId" = p.id AND m."entityType" = 'payment'
    WHERE p."deletedAt" IS NULL
  `;
  const withoutLegacy = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n
    FROM "Payment" p
    WHERE p."deletedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "MigrationLegacyId" m
        WHERE m."newId" = p.id AND m."entityType" = 'payment'
      )
  `;

  const book = await prisma.$queryRaw<
    Array<{ bucket: string; n: number }>
  >`
    SELECT bucket, COUNT(*)::int AS n FROM (
      SELECT
        CASE
          WHEN "subType" IS NULL
               AND "paymentId" IS NULL
               AND "saleId" IS NULL
               AND "expenseId" IS NULL
            THEN 'import_orphan_book'
          WHEN "subType" IN (
            'sale_payment','purchase_payment','expense',
            'opening_balance','deposit','fund_transfer',
            'purchase_payment','sale_payment'
          ) THEN 'app_style_subtype'
          WHEN EXISTS (
            SELECT 1 FROM "MigrationLegacyId" m
            WHERE m."newId" = x."paymentId" AND m."entityType" = 'payment'
          ) THEN 'linked_to_legacy_payment'
          ELSE 'other'
        END AS bucket
      FROM "AccountTransaction" x
      WHERE x."deletedAt" IS NULL
    ) t
    GROUP BY bucket
    ORDER BY n DESC
  `;

  console.log({
    activePayments: active,
    withLegacyMap: withLegacy[0]?.n ?? 0,
    withoutLegacyMap: withoutLegacy[0]?.n ?? 0,
    activeBookBuckets: book,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
