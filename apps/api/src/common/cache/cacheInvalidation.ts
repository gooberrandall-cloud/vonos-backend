import { CacheService } from './cache.service';

/** Match overview groupOverviewCacheWindowKey default (no from/to). */
function currentGroupOverviewWindowKey(): string {
  const bucketMs = 5 * 60 * 1000;
  const floor = new Date(
    Math.floor(Date.now() / bucketMs) * bucketMs,
  ).toISOString();
  return `${floor}:${floor}`;
}

/**
 * Bust tenant-scoped dashboard, finance, and report caches after writes.
 *
 * Tenant-scoped keys use `v{version}:…` — bumping the version is enough.
 * Group overview keys are not versioned; delete the current time-bucket keys
 * + clear L1. Avoid Upstash SCAN (`invalidatePrefix`) — REST SCAN on every
 * write was multi-second and contended with other traffic.
 */
export async function invalidateTenantDashboardCache(
  cache: CacheService,
  tenantId: string,
): Promise<void> {
  // Bump first so subsequent reads miss; group-overview DEL is best-effort.
  await cache.bumpTenantVersion(tenantId);
  const window = currentGroupOverviewWindowKey();
  cache.clearL1Matching([
    'group-overview:',
    'report-group:',
    'ledger-group-',
  ]);
  void cache.del(
    `group-overview:${window}`,
    `group-overview:summary:${window}`,
    `group-overview:details:${window}`,
  );
}

/**
 * Bust only list-page caches for the given resources (sales, customers, …).
 * Use for provisional / metadata writes that must not cold-miss hq6-home or
 * reports. Finance-affecting writes should still call
 * {@link invalidateTenantDashboardCache}.
 */
export async function invalidateTenantListCache(
  cache: CacheService,
  tenantId: string,
  resources: string[],
): Promise<void> {
  await Promise.all(
    resources.map((resource) => cache.bumpListVersion(tenantId, resource)),
  );
}
