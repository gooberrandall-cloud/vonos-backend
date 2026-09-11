import type { PrismaClient } from '@prisma/client';
import type { CacheService } from '../cache/cache.service';

const LEGACY_MAP_TTL_S = 900;

export type LegacyEntityType = 'customer' | 'supplier';

type LegacyIdClient = {
  migrationLegacyId: {
    findMany: PrismaClient['migrationLegacyId']['findMany'];
  };
};

function formatContactId(
  entityType: LegacyEntityType,
  legacyId: number,
): string {
  const prefix = entityType === 'customer' ? 'CU' : 'CO';
  return `${prefix}${String(legacyId).padStart(4, '0')}`;
}

/**
 * Load + cache the full tenant legacy map (boot/cron only).
 * Do not call from request list paths — can be multi-second on large tenants.
 */
export async function warmLegacyContactIdMap(
  prisma: LegacyIdClient,
  cache: CacheService,
  tenantId: string,
  entityType: LegacyEntityType,
): Promise<Map<string, string>> {
  const cacheKey = await cache.tenantScopedKey(
    tenantId,
    `legacy-map:${entityType}`,
  );
  const hit = await cache.get<Record<string, string>>(cacheKey);
  if (hit) {
    return new Map(Object.entries(hit));
  }

  const rows = await prisma.migrationLegacyId.findMany({
    where: { tenantId, entityType },
    select: { newId: true, legacyId: true },
  });
  const record: Record<string, string> = {};
  for (const row of rows) {
    record[row.newId] = formatContactId(entityType, row.legacyId);
  }
  await cache.set(cacheKey, record, LEGACY_MAP_TTL_S);
  return new Map(Object.entries(record));
}

/**
 * Resolve contact IDs for one list page.
 * Prefers the warm full map (0 extra Neon RTT). On miss, page-scoped IN query only
 * — never scans the whole MigrationLegacyId table on a user request.
 */
export async function getLegacyContactIdsForPage(
  prisma: LegacyIdClient,
  cache: CacheService,
  tenantId: string,
  entityType: LegacyEntityType,
  newIds: string[],
): Promise<Map<string, string>> {
  if (newIds.length === 0) return new Map();

  const cacheKey = await cache.tenantScopedKey(
    tenantId,
    `legacy-map:${entityType}`,
  );
  const hit = await cache.get<Record<string, string>>(cacheKey);
  if (hit) {
    const map = new Map<string, string>();
    for (const id of newIds) {
      const value = hit[id];
      if (value) map.set(id, value);
    }
    return map;
  }

  const rows = await prisma.migrationLegacyId.findMany({
    where: {
      tenantId,
      entityType,
      newId: { in: newIds },
    },
    select: { newId: true, legacyId: true },
  });
  return new Map(
    rows.map((row) => [row.newId, formatContactId(entityType, row.legacyId)]),
  );
}

/** @deprecated Use warmLegacyContactIdMap / getLegacyContactIdsForPage */
export async function getLegacyContactIdMap(
  prisma: LegacyIdClient,
  cache: CacheService,
  tenantId: string,
  entityType: LegacyEntityType,
): Promise<Map<string, string>> {
  return warmLegacyContactIdMap(prisma, cache, tenantId, entityType);
}
