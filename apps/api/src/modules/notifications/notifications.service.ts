import { Injectable } from '@nestjs/common';
import type { Notification, NotificationSeverity } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toIso } from '../../common/utils/serializers';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
  ) {}

  async list(userId: string): Promise<Notification[]> {
    const tenantId = this.tenantDb.resolveTenantId();
    const rows = await this.prisma.notification.findMany({
      where: {
        OR: [{ userId }, ...(tenantId ? [{ tenantId, userId: null }] : [])],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return rows.map((row) => ({
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
  }

  async markRead(id: string, userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        id,
        OR: [{ userId }, { userId: null }],
      },
      data: { read: true },
    });
  }
}
