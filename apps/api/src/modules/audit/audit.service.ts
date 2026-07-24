import { Injectable, Scope } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  AuditLogEntry,
  AuditLogFilters,
  NotificationSeverity,
} from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { toIso } from '../../common/utils/serializers';

export interface AuditLogInput {
  action: string;
  entityType: string;
  entityId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

@Injectable({ scope: Scope.REQUEST })
export class AuditService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
  ) {}

  async list(filters: AuditLogFilters): Promise<AuditLogEntry[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'occurredAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.tenantDb.db.auditLog.findMany({
      where: {
        tenantId,
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
        ...(filters.entityId ? { entityId: filters.entityId } : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    return rows.map((row) => this.serialize(row));
  }

  async listRecent(limit = 10): Promise<AuditLogEntry[]> {
    return this.list({ limit });
  }

  async createdByFields(): Promise<{
    createdByUserId?: string | null;
    createdByName?: string | null;
  }> {
    const actor = await this.resolveActor();
    if (!actor) return {};
    return { createdByUserId: actor.userId, createdByName: actor.name };
  }

  async log(input: AuditLogInput): Promise<void> {
    void this.persistLog(input).catch((err) => {
      console.error('Audit log failed', err);
    });
  }

  private async persistLog(input: AuditLogInput): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const actor = await this.resolveActor();
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        actorUserId: actor?.userId ?? null,
        actorName: actor?.name ?? null,
        summary: input.summary,
        metadata: (input.metadata ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        occurredAt: new Date(),
      },
    });

    await this.prisma.notification.create({
      data: {
        tenantId,
        userId: null,
        type: `${input.entityType}.${input.action}`,
        title: this.notificationTitle(input.action, input.entityType),
        message: input.summary,
        severity: this.severityForAction(input.action),
        linkedRecordType: input.entityId ? input.entityType : null,
        linkedRecordId: input.entityId ?? null,
        read: false,
      },
    });
  }

  private notificationTitle(action: string, entityType: string): string {
    const label = this.humanizeEntityType(entityType);
    switch (action) {
      case 'created':
        return `${label} created`;
      case 'updated':
        return `${label} updated`;
      case 'deleted':
        return `${label} removed`;
      case 'status_changed':
        return `${label} status updated`;
      default:
        return `${label} ${action.replace(/_/g, ' ')}`;
    }
  }

  private severityForAction(action: string): NotificationSeverity {
    switch (action) {
      case 'created':
        return 'success';
      case 'deleted':
        return 'warning';
      case 'status_changed':
        return 'info';
      default:
        return 'info';
    }
  }

  private humanizeEntityType(entityType: string): string {
    const labels: Record<string, string> = {
      item: 'Item',
      stockMovement: 'Stock movement',
      job: 'Job',
      sale: 'Sale',
      supplier: 'Supplier',
      appointment: 'Appointment',
      ledgerEntry: 'Ledger entry',
      user: 'User',
      cafeTable: 'Table',
    };
    return (
      labels[entityType] ??
      entityType
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, (c) => c.toUpperCase())
    );
  }

  private async resolveActor(): Promise<{
    userId: string;
    name: string;
  } | null> {
    const userId = this.tenantDb.getAuthUserId();
    if (!userId) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });
    if (!user) return null;
    return { userId: user.id, name: user.name };
  }

  private serialize(row: {
    id: string;
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string | null;
    actorUserId: string | null;
    actorName: string | null;
    summary: string;
    metadata: unknown;
    occurredAt: Date;
  }): AuditLogEntry {
    return {
      id: row.id,
      tenantId: row.tenantId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actorUserId: row.actorUserId,
      actorName: row.actorName,
      summary: row.summary,
      metadata:
        row.metadata &&
        typeof row.metadata === 'object' &&
        !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : null,
      occurredAt: toIso(row.occurredAt),
    };
  }
}
