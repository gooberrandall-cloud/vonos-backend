/**
 * Reset all item stock quantities to 0 across every tenant.
 * Also zeros ItemLocationStock rows and marks items out_of_stock.
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/reset-all-stock-to-zero.ts
 *   npx ts-node ... reset-all-stock-to-zero.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const itemWhere = {
    deletedAt: null,
    OR: [{ quantity: { not: 0 } }, { status: { not: 'out_of_stock' as const } }],
  };

  const [itemsToTouch, locNonZero, itemCount, locCount] = await Promise.all([
    prisma.item.count({ where: itemWhere }),
    prisma.itemLocationStock.count({ where: { quantity: { not: 0 } } }),
    prisma.item.count({ where: { deletedAt: null } }),
    prisma.itemLocationStock.count(),
  ]);

  console.log(
    JSON.stringify(
      {
        dryRun,
        activeItems: itemCount,
        locationStockRows: locCount,
        itemsNeedingReset: itemsToTouch,
        locationRowsNonZero: locNonZero,
      },
      null,
      2,
    ),
  );

  if (dryRun) {
    console.log('Dry run only — no writes.');
    return;
  }

  const [locResult, itemResult] = await prisma.$transaction([
    prisma.itemLocationStock.updateMany({
      data: { quantity: 0 },
      where: { quantity: { not: 0 } },
    }),
    prisma.item.updateMany({
      where: { deletedAt: null },
      data: { quantity: 0, status: 'out_of_stock' },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        locationStockZeroed: locResult.count,
        itemsZeroed: itemResult.count,
      },
      null,
      2,
    ),
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
