/**
 * One-time backfill: create an ItemLocationStock row for every existing Item so
 * per-location quantity tracking has a starting point. Each item's whole
 * quantity is placed at its current (locationCode, binLocation).
 *
 * Idempotent: items that already have any location-stock rows are skipped.
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/backfill-item-location-stock.ts
 *   npx ts-node ... backfill-item-location-stock.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const items = await prisma.item.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      tenantId: true,
      quantity: true,
      locationCode: true,
      binLocation: true,
    },
  });

  let created = 0;
  let skipped = 0;

  for (const item of items) {
    const existing = await prisma.itemLocationStock.count({
      where: { itemId: item.id },
    });
    if (existing > 0) {
      skipped += 1;
      continue;
    }

    // Without a location code there is nowhere to place the stock; leave the
    // flat Item.quantity as the source of truth until a location is assigned.
    const locationCode = item.locationCode?.trim();
    if (!locationCode) {
      skipped += 1;
      continue;
    }

    if (dryRun) {
      created += 1;
      continue;
    }

    await prisma.itemLocationStock.create({
      data: {
        tenantId: item.tenantId,
        itemId: item.id,
        locationCode,
        binLocation: item.binLocation?.trim() || '',
        quantity: item.quantity,
      },
    });
    created += 1;
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Backfill complete. items=${items.length} created=${created} skipped=${skipped}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
