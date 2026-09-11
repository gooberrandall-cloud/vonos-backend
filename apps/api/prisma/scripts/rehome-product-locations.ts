/**
 * Remap Item / ItemLocationStock location codes onto each tenant's own
 * product home (VISP→VISP, VSP→VSP, …).
 *
 * Legacy Ultimate POS / shared-catalog imports left many institute rows with
 * locationCode = "BL005" ("VONOS PAINTING MATERIALS") or sister-entity codes
 * (VW / VP). Those labels leak into the products list and block location edit
 * because the VISP form only allows the VISP home.
 *
 * Usage:
 *   npx tsx prisma/scripts/rehome-product-locations.ts
 *   TENANTS=VISP npx tsx prisma/scripts/rehome-product-locations.ts --execute
 */
import { PrismaClient } from '@prisma/client';

const DEFAULT_TENANTS = ['VSP', 'VISP'] as const;

const execute = process.argv.includes('--execute');
const tenantFilter = (process.env.TENANTS ?? DEFAULT_TENANTS.join(','))
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

async function main() {
  const prisma = new PrismaClient();
  try {
    const tenants = await prisma.tenant.findMany({
      where: { code: { in: tenantFilter }, deletedAt: null },
      select: { id: true, code: true },
    });

    if (tenants.length === 0) {
      console.log(`No tenants matched: ${tenantFilter.join(', ')}`);
      return;
    }

    console.log(
      execute
        ? 'EXECUTE — rewriting foreign product homes to own tenant'
        : 'DRY RUN (pass --execute to apply)',
    );

    for (const tenant of tenants) {
      const home = tenant.code.trim().toUpperCase();

      const itemCount = await prisma.item.count({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          NOT: { locationCode: home },
        },
      });

      const stockCount = await prisma.itemLocationStock.count({
        where: {
          item: { tenantId: tenant.id, deletedAt: null },
          NOT: { locationCode: home },
        },
      });

      const blankItems = await prisma.item.count({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          OR: [{ locationCode: null }, { locationCode: '' }],
        },
      });

      const foreignCodes = await prisma.itemLocationStock.groupBy({
        by: ['locationCode'],
        where: {
          item: { tenantId: tenant.id, deletedAt: null },
          NOT: { locationCode: home },
        },
        _count: { _all: true },
      });

      console.log(
        `${home}: ${itemCount} item(s) with foreign/blank location, ` +
          `${stockCount} locationStock row(s), ${blankItems} blank location(s)`,
      );
      if (foreignCodes.length > 0) {
        console.log(
          '  stock codes:',
          foreignCodes
            .map((row) => `${row.locationCode}×${row._count._all}`)
            .join(', '),
        );
      }

      if (!execute) continue;

      const itemResult = await prisma.item.updateMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          locationCode: { not: home },
        },
        data: { locationCode: home },
      });

      const blankResult = await prisma.item.updateMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          OR: [{ locationCode: null }, { locationCode: '' }],
        },
        data: { locationCode: home },
      });

      // Merge foreign stock into an existing home row (same item + bin), then
      // delete the foreign duplicate — bulk SQL so remote DBs stay fast.
      const merged = await prisma.$executeRaw`
        WITH foreign_rows AS (
          SELECT ils.id, ils."itemId", ils."binLocation", ils.quantity
          FROM "ItemLocationStock" ils
          INNER JOIN "Item" i ON i.id = ils."itemId"
          WHERE i."tenantId" = ${tenant.id}
            AND i."deletedAt" IS NULL
            AND ils."locationCode" <> ${home}
        ),
        collisions AS (
          SELECT f.id AS foreign_id, h.id AS home_id, f.quantity AS foreign_qty
          FROM foreign_rows f
          INNER JOIN "ItemLocationStock" h
            ON h."itemId" = f."itemId"
           AND h."locationCode" = ${home}
           AND h."binLocation" = f."binLocation"
        ),
        bump AS (
          UPDATE "ItemLocationStock" h
          SET quantity = h.quantity + c.foreign_qty,
              "updatedAt" = NOW()
          FROM collisions c
          WHERE h.id = c.home_id
          RETURNING c.foreign_id
        )
        DELETE FROM "ItemLocationStock" ils
        USING bump
        WHERE ils.id = bump.foreign_id
      `;

      const remapped = await prisma.$executeRaw`
        UPDATE "ItemLocationStock" ils
        SET "locationCode" = ${home},
            "updatedAt" = NOW()
        FROM "Item" i
        WHERE i.id = ils."itemId"
          AND i."tenantId" = ${tenant.id}
          AND i."deletedAt" IS NULL
          AND ils."locationCode" <> ${home}
      `;

      console.log(
        `  → items: ${itemResult.count} remapped, ${blankResult.count} filled; ` +
          `stock: ${Number(remapped)} remapped, ${Number(merged)} collision merge(s)`,
      );
    }

    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
