/**
 * Refresh TenantEntitySnapshot rows and warm group overview Redis/L1 cache.
 * Usage (from apps/api):
 *   npx tsx prisma/scripts/refresh-entity-snapshots.ts
 */
import { PrismaClient } from '@prisma/client';
import { CacheService } from '../../src/common/cache/cache.service';
import { refreshTenantEntitySnapshots } from '../../src/common/utils/tenantEntitySnapshot';
import { warmHotPathsCache } from '../../src/common/utils/warmHotPathsCache';

async function main() {
  const prisma = new PrismaClient();
  const cache = new CacheService();
  await cache.onModuleInit();

  console.log('Refreshing TenantEntitySnapshot for all group tenants…');
  const rows = await refreshTenantEntitySnapshots(prisma);
  console.log(`Snapshots: ${rows} tenant row(s) upserted.`);

  console.log('Warming hot-path caches (overview, finance, reports, VA)…');
  await warmHotPathsCache(prisma, cache);
  console.log('Done: snapshots refreshed and hot-path caches warmed.');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
