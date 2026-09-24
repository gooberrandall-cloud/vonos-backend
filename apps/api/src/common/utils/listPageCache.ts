import type { CacheService } from '../cache/cache.service';

/** Short TTL — list pages change often; version bump invalidates earlier. */
export const LIST_PAGE_CACHE_TTL_S = 600;

/** In-flight loaders keyed by cache key — collapses concurrent identical misses. */
const inflight = new Map<string, Promise<unknown>>();

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
 * Keys use a per-resource list version so provisional writes can bust sales
 * lists without cold-missing hq6/reports (those use the global tenant version).
 * Concurrent identical misses share one loader (single-flight) so 15 users
 * opening Sales at once hit Neon once, not 15×.
 *
 * Finance-affecting writes should still bump the global tenant version (which
 * also invalidates older list keys that still embed `v{n}:`).
 */
export async function withListPageCache<T>(
  cache: CacheService,
  tenantId: string,
  resource: string,
  filterKey: string,
  loader: () => Promise<T>,
  ttlSeconds = LIST_PAGE_CACHE_TTL_S,
): Promise<T> {
  const cacheKey = await cache.tenantScopedListKey(
    tenantId,
    resource,
    `list:${resource}:${filterKey}`,
  );
  const hit = await cache.get<T>(cacheKey);
  if (hit != null) return hit;

  const existing = inflight.get(cacheKey);
  if (existing) {
    return existing as Promise<T>;
  }

  const pending = (async () => {
    try {
      // Skip a second Redis GET on miss — single-flight already collapses
      // same-process races; cross-process duplicates are rare vs +1 Upstash RTT.
      const value = await loader();
      // Return rows before Upstash write finishes — set is best-effort cache fill.
      void cache.set(cacheKey, value, ttlSeconds);
      return value;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, pending);
  return pending;
}
