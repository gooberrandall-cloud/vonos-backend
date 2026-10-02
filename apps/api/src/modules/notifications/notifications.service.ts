import { Injectable } from '@nestjs/common';
import type { Notification, NotificationSeverity } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { toIso } from '../../common/utils/serializers';

const NOTIFICATIONS_TTL_S = 60;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async list(userId: string): Promise<Notification[]> {
    const tenantId = this.tenantDb.resolveTenantId();
    const cacheKey = `notifications:${userId}:${tenantId ?? 'none'}`;
    const cached = await this.cache.get<Notification[]>(cacheKey);
    if (cached) return cached;

    const rows = await this.prisma.notification.findMany({
      where: {
        OR: [{ userId }, ...(tenantId ? [{ tenantId, userId: null }] : [])],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const items = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      type: row.type,
      title: row.title,
      message: row.message,
      severity: row.severity as NotificationSeverity,
      linkedRecordType: row.linkedRecordType,
      linkedRecordId: row.linkedRecordId,
      read: row.read,
      createdAt: toIso(row.createdAt),
    }));
    await this.cache.set(cacheKey, items, NOTIFICATIONS_TTL_S);
    return items;
  }

  async markRead(id: string, userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        id,
        OR: [{ userId }, { userId: null }],
      },
      data: { read: true },
    });
    const tenantId = this.tenantDb.resolveTenantId();
    await this.cache.invalidatePrefix(`notifications:${userId}:`);
    if (tenantId) {
      await this.cache.invalidatePrefix(`notifications:${userId}:${tenantId}`);
    }
  }
}
