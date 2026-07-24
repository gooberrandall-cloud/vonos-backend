/**
 * One-off backfill of Supplier purchase rollup columns.
 * Usage (from apps/api): npx ts-node --transpile-only prisma/scripts/backfill-supplier-rollups.ts
 */
import { PrismaClient } from '@prisma/client';
import type { TenantScopedPrisma } from '../../src/common/prisma/prisma.service';
import { refreshSupplierPurchaseRollups } from '../../src/common/utils/supplierRollups';

async function main() {
  const prisma = new PrismaClient();
  const suppliers = await prisma.supplier.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  console.log(`Refreshing rollups for ${suppliers.length} suppliers…`);
  let done = 0;
  for (const supplier of suppliers) {
    await refreshSupplierPurchaseRollups(
      prisma as unknown as TenantScopedPrisma,
      supplier.id,
    );
    done += 1;
    if (done % 50 === 0) console.log(`  ${done}/${suppliers.length}`);
  }
  console.log(`Done: ${done}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
