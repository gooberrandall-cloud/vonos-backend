/**
 * Seed HQ6 customer groups on all operating tenants (union / fill gaps).
 * Legacy Ultimate POS had: "Clients with cars", "Corporate" (0% discount).
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/sync-customer-groups-across-tenants.ts
 *   npx ts-node ... sync-customer-groups-across-tenants.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

const OPERATING = new Set([
  'VA',
  'VW',
  'VISP',
  'VSP',
  'VP',
  'VC',
  'VS',
  'VKW',
]);

/** Canonical HQ6 groups (from legacy customer_groups dump). */
const CANONICAL: Array<{ name: string; discountPercent: number }> = [
  { name: 'Clients with cars', discountPercent: 0 },
  { name: 'Corporate', discountPercent: 0 },
];

function groupKey(name: string): string {
  return name.trim().toLowerCase();
}

async function main() {
  const tenants = (
    await prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true, code: true },
    })
  ).filter((t) => OPERATING.has(t.code.toUpperCase()));

  // Union: canonical + any groups already present on any tenant
  const byName = new Map(
    CANONICAL.map((g) => [groupKey(g.name), { ...g }]),
  );

  for (const t of tenants) {
    const existing = await prisma.customerGroup.findMany({
      where: { tenantId: t.id, deletedAt: null },
      select: { name: true, discountPercent: true },
    });
    for (const row of existing) {
      const key = groupKey(row.name);
      if (!byName.has(key)) {
        byName.set(key, {
          name: row.name,
          discountPercent: Number(row.discountPercent),
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        tenants: tenants.map((t) => t.code),
        union: [...byName.values()],
      },
      null,
      2,
    ),
  );

  let created = 0;

  for (const target of tenants) {
    const have = new Set(
      (
        await prisma.customerGroup.findMany({
          where: { tenantId: target.id, deletedAt: null },
          select: { name: true },
        })
      ).map((g) => groupKey(g.name)),
    );

    const missing = [...byName.values()].filter(
      (g) => !have.has(groupKey(g.name)),
    );

    console.log(
      JSON.stringify({
        target: target.code,
        willCreate: missing.map((g) => g.name),
      }),
    );

    if (dryRun || missing.length === 0) continue;

    const res = await prisma.customerGroup.createMany({
      data: missing.map((g) => ({
        tenantId: target.id,
        name: g.name,
        discountPercent: g.discountPercent,
      })),
      skipDuplicates: true,
    });
    created += res.count;
  }

  console.log(JSON.stringify({ dryRun, created }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
