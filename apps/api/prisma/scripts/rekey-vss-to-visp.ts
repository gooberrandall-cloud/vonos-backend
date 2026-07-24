/**
 * One-time re-key: tenant_vss_001 (mislabeled VSS) → tenant_visp_001 (VISP).
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/rekey-vss-to-visp.ts --dry-run
 *   npx ts-node ... prisma/scripts/rekey-vss-to-visp.ts
 */
import { PrismaClient } from '@prisma/client';

const SOURCE_ID = 'tenant_vss_001';
const TARGET_ID = 'tenant_visp_001';
const TARGET_CODE = 'VISP';
const TARGET_NAME = 'Vonos Institute Spare Parts';

const TENANT_SCOPED_TABLES = [
  'Appointment',
  'Item',
  'StockMovement',
  'Supplier',
  'Job',
  'LedgerEntry',
  'Customer',
  'Sale',
  'MigrationLegacyId',
  'Vehicle',
  'Requisition',
  'SalonService',
  'CafeTable',
  'AuditLog',
  'PaymentAccount',
  'AccountTransaction',
  'Payment',
  'ProductCategory',
  'Brand',
  'ProductUnit',
  'Warranty',
  'SellingPriceGroup',
] as const;

const dryRun = process.argv.includes('--dry-run');

function patchConfigRoutes(config: unknown): object {
  const raw = JSON.stringify(config ?? {});
  const patched = raw
    .replaceAll('/VSS/', '/VISP/')
    .replaceAll('"code":"VSS"', '"code":"VISP"')
    .replaceAll('"tenantId":"tenant_vss_001"', `"tenantId":"${TARGET_ID}"`)
    .replaceAll('Vonos Spare Shop', TARGET_NAME);
  return JSON.parse(patched) as object;
}

async function countByTenant(prisma: PrismaClient, tenantId: string) {
  const [item, sale, customer, user] = await Promise.all([
    prisma.item.count({ where: { tenantId, deletedAt: null } }),
    prisma.sale.count({ where: { tenantId, deletedAt: null } }),
    prisma.customer.count({ where: { tenantId, deletedAt: null } }),
    prisma.user.count({ where: { tenantId } }),
  ]);
  return { Item: item, Sale: sale, Customer: customer, User: user };
}

async function main() {
  const prisma = new PrismaClient();

  try {
    const source = await prisma.tenant.findUnique({ where: { id: SOURCE_ID } });
    if (!source) {
      console.log(`Source tenant ${SOURCE_ID} not found — already re-keyed or empty DB.`);
      return;
    }

    const existingTarget = await prisma.tenant.findUnique({ where: { id: TARGET_ID } });
    if (existingTarget && existingTarget.id !== SOURCE_ID) {
      throw new Error(
        `Target ${TARGET_ID} already exists separately. Resolve manually before re-key.`,
      );
    }

    const before = await countByTenant(prisma, SOURCE_ID);
    console.log('Before:', before);

    if (dryRun) {
      console.log(`[dry-run] Would re-key ${SOURCE_ID} → ${TARGET_ID} (${TARGET_CODE})`);
      return;
    }

    await prisma.$transaction(
      async (tx) => {
      const config = patchConfigRoutes(source.config);

      if (!existingTarget) {
        await tx.tenant.create({
          data: {
            id: TARGET_ID,
            code: `${TARGET_CODE}_TEMP`,
            name: TARGET_NAME,
            archetype: source.archetype,
            config,
          },
        });
      }

      for (const table of TENANT_SCOPED_TABLES) {
        const result = await tx.$executeRawUnsafe(
          `UPDATE "${table}" SET "tenantId" = $1 WHERE "tenantId" = $2`,
          TARGET_ID,
          SOURCE_ID,
        );
        if (result > 0) {
          console.log(`  ${table}: ${result} rows`);
        }
      }

      await tx.$executeRawUnsafe(
        `UPDATE "Notification" SET "tenantId" = $1 WHERE "tenantId" = $2`,
        TARGET_ID,
        SOURCE_ID,
      );

      await tx.user.updateMany({
        where: { tenantId: SOURCE_ID },
        data: { tenantId: TARGET_ID },
      });

      await tx.tenant.delete({ where: { id: SOURCE_ID } });

      await tx.tenant.update({
        where: { id: TARGET_ID },
        data: {
          code: TARGET_CODE,
          name: TARGET_NAME,
          config,
        },
      });

      const vssAdmin = await tx.user.findUnique({ where: { email: 'admin@vss.vonos' } });
      if (vssAdmin) {
        await tx.user.update({
          where: { id: vssAdmin.id },
          data: {
            email: 'admin@visp.vonos',
            name: 'VISP Admin',
            tenantId: TARGET_ID,
          },
        });
      }
    },
      { timeout: 120_000 },
    );

    const after = await countByTenant(prisma, TARGET_ID);
    console.log('After:', after);
    console.log(`Re-keyed ${SOURCE_ID} → ${TARGET_ID} (${TARGET_CODE})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
