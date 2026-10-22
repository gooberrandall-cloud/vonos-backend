import type { PrismaService } from '../prisma/prisma.service';
import type { CacheService } from './cache.service';

/** Drop cached access-token version checks + TenantRole permission snapshots. */
export async function invalidateUserAuthSession(
  cache: CacheService,
  userId: string,
): Promise<void> {
  await Promise.all([
    cache.invalidatePrefix(`auth:tv:${userId}:`),
    cache.invalidatePrefix(`auth:tenantRoleCtx:${userId}:`),
  ]);
}

/**
 * After a TenantRole matrix changes (or a user is reassigned), bump
 * `tokenVersion` so the next API call forces a session refresh and the UI
 * picks up the new permission keys without a full re-login.
 */
export async function bumpAuthSessionsForTenantRoles(
  prisma: PrismaService,
  cache: CacheService,
  tenantRoleIds: string[],
): Promise<void> {
  const ids = [...new Set(tenantRoleIds.filter(Boolean))];
  if (ids.length === 0) return;

  const users = await prisma.user.findMany({
    where: { tenantRoleId: { in: ids }, deletedAt: null },
    select: { id: true },
  });
  if (users.length === 0) return;

  await prisma.user.updateMany({
    where: { id: { in: users.map((u) => u.id) } },
    data: { tokenVersion: { increment: 1 } },
  });

  await Promise.all(
    users.map((u) => invalidateUserAuthSession(cache, u.id)),
  );
}
