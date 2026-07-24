import type { CacheService } from '../cache/cache.service';

/** Short TTL — list pages change often; version bump invalidates earlier. */
export const LIST_PAGE_CACHE_TTL_S = 180;

/** Stable cache segment from list filter bag (order-independent). */
export function listPageFilterKey(
  parts: Record<string, string | number | boolean | null | undefined>,
): string {
  return Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key] ?? ''}`)
    .join('&');
}

/**
 * Cache a tenant list page under `list:{resource}:{filterKey}`.
 * Keys are version-scoped so writes that bumpTenantVersion bust them.
 */
export async function withListPageCache<T>(
  cache: CacheService,
  tenantId: string,
  resource: string,
  filterKey: string,
  loader: () => Promise<T>,
  ttlSeconds = LIST_PAGE_CACHE_TTL_S,
): Promise<T> {
  const cacheKey = await cache.tenantScopedKey(
    tenantId,
    `list:${resource}:${filterKey}`,
  );
  const hit = await cache.get<T>(cacheKey);
  if (hit != null) return hit;
  const value = await loader();
  await cache.set(cacheKey, value, ttlSeconds);
  return value;
}
