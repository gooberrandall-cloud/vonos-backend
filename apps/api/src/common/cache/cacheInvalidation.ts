import { CacheService } from './cache.service';

/** Bust tenant-scoped dashboard, finance, and report caches after writes. */
export async function invalidateTenantDashboardCache(
  cache: CacheService,
  tenantId: string,
): Promise<void> {
  await cache.bumpTenantVersion(tenantId);
  await Promise.all([
    cache.invalidatePrefix('group-overview:'),
    cache.invalidatePrefix('report-group:'),
    cache.invalidatePrefix('ledger-group-'),
  ]);
}
