import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const VA = "tenant_va_001";
  const ranges = await p.$queryRaw<
    Array<{ bucket: string; c: number; min_id: number; max_id: number }>
  >`
    SELECT
      CASE
        WHEN "legacyId" < 10000000 THEN 'quotation_0'
        WHEN "legacyId" < 20000000 THEN 'ops_10m'
        WHEN "legacyId" < 30000000 THEN 'hq3_20m'
        ELSE 'hq2_30m'
      END AS bucket,
      COUNT(*)::int AS c,
      MIN("legacyId")::int AS min_id,
      MAX("legacyId")::int AS max_id
    FROM "MigrationLegacyId"
    WHERE "tenantId" = ${VA} AND "entityType" = 'customer'
    GROUP BY 1
    ORDER BY 1
  `;

  const total = await p.customer.count({
    where: { tenantId: VA, deletedAt: null },
  });
  const withDetailsContactId = await p.$queryRaw<Array<{ c: number }>>`
    SELECT COUNT(*)::int AS c FROM "Customer"
    WHERE "tenantId" = ${VA}
      AND "deletedAt" IS NULL
      AND COALESCE(details->>'contactId','') <> ''
  `;

  // Match a known plate from SQL via legacy 38 (quotation) or 20000038 (hq3)
  const plate38 = await p.migrationLegacyId.findMany({
    where: {
      tenantId: VA,
      entityType: "customer",
      legacyId: { in: [38, 10_000_038, 20_000_038, 30_000_038] },
    },
  });

  console.log(
    JSON.stringify({ ranges, total, withDetailsContactId, plate38 }, null, 2),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
