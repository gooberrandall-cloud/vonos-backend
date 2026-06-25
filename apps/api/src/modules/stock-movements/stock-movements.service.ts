import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  MovementSource,
  MovementStatus,
  MovementType,
} from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { buildCursorQuery } from '../../common/utils/pagination';
import {
  computeStockStatus,
  parseMovementLines,
  shouldApplyInboundQty,
  shouldApplyOutboundQty,
} from '../../common/utils/stockQuantity';
import {
  serializeMovement,
  toMovementListRow,
  toTransferRow,
  type StockMovementListRow,
  type TransferRow,
  type TransferZoneSummary,
} from './stock-movements.mapper';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class StockMovementsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(filters: {
    type?: MovementType;
    status?: MovementStatus;
    source?: MovementSource;
    cursor?: string;
    limit?: number;
  }): Promise<StockMovementListRow[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.stockMovement.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.source ? { source: filters.source } : {}),
      },
      include: { supplier: { select: { name: true } } },
      orderBy: { date: 'desc' },
      ...buildCursorQuery(filters.cursor, filters.limit ?? 50),
    });
    return rows.map(toMovementListRow);
  }

  async getById(id: string) {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Movement not found');
    return serializeMovement(row);
  }

  async updateStatus(id: string, status: MovementStatus) {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Movement not found');

    const lines = parseMovementLines(existing.lines);
    const applyInbound =
      existing.type === 'inbound' &&
      shouldApplyInboundQty(existing.status, status);
    const applyOutbound =
      existing.type === 'outbound' &&
      shouldApplyOutboundQty(existing.status, status);

    if (applyInbound || applyOutbound) {
      const db = this.prisma.forTenant(tenantId);
      await db.$transaction(async (tx) => {
        for (const line of lines) {
          const item = await tx.item.findFirst({
            where: { id: line.itemId, tenantId, deletedAt: null },
          });
          if (!item) {
            throw new BadRequestException(
              `Item not found: ${line.sku || line.itemId}`,
            );
          }

          const delta = applyInbound ? line.quantity : -line.quantity;
          const nextQuantity = item.quantity + delta;
          if (nextQuantity < 0) {
            throw new BadRequestException(
              `Insufficient stock for ${line.sku || item.sku} (need ${line.quantity}, have ${item.quantity})`,
            );
          }

          await tx.item.update({
            where: { id: item.id },
            data: {
              quantity: nextQuantity,
              status: computeStockStatus(nextQuantity, item.reorderPoint),
            },
          });
        }

        await tx.stockMovement.update({
          where: { id },
          data: { status },
        });

        if (applyInbound && status === 'Received') {
          const totalCost = lines.reduce((sum, line) => {
            const unitCost = (line as { unitCost?: number }).unitCost ?? 0;
            return sum + unitCost * line.quantity;
          }, 0);
          if (totalCost > 0) {
            await tx.ledgerEntry.create({
              data: {
                tenantId,
                type: 'cost',
                amount: totalCost,
                currency: 'NGN',
                category: 'Purchases',
                description: `Inbound ${existing.reference}`,
                linkedRecordType: 'stock_movement',
                linkedRecordId: id,
                date: existing.date,
              },
            });
          }
        }
      });
    } else {
      await this.tenantDb.db.stockMovement.update({
        where: { id },
        data: { status },
      });
    }

    const row = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Movement not found');
    await this.auditService.log({
      action: 'updated',
      entityType: 'stockMovement',
      entityId: id,
      summary: `Status → ${status}`,
      metadata: { previousStatus: existing.status, status },
    });
    return serializeMovement(row);
  }

  async create(body: {
    type: MovementType;
    reference: string;
    status?: MovementStatus;
    lines: Array<{
      itemId: string;
      sku: string;
      name: string;
      quantity: number;
      unitCost?: number;
    }>;
    notes?: string;
    locationCode?: string;
    supplierId?: string;
    source?: MovementSource;
    date?: string;
  }) {
    const tenantId = this.tenantDb.requireTenantId();
    const createdBy = await this.auditService.createdByFields();
    const locationCode = await this.tenantDb.resolveBusinessLocation(
      body.locationCode,
    );
    const row = await this.tenantDb.db.stockMovement.create({
      data: {
        tenantId,
        type: body.type,
        reference: body.reference,
        status: body.status ?? 'Pending',
        lines: body.lines,
        notes: body.notes ?? null,
        supplierId: body.supplierId ?? null,
        source: body.source ?? 'standard',
        locationCode,
        date: body.date ? new Date(body.date) : new Date(),
        ...createdBy,
      },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'stockMovement',
      entityId: row.id,
      summary: `Created ${body.type} movement ${row.reference}`,
    });
    return serializeMovement(row);
  }

  async listTransfers(filters: {
    cursor?: string;
    limit?: number;
  }): Promise<TransferRow[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.stockMovement.findMany({
      where: { tenantId, deletedAt: null, type: 'transfer' },
      orderBy: { date: 'desc' },
      ...buildCursorQuery(filters.cursor, filters.limit ?? 50),
    });
    return rows.map(toTransferRow);
  }

  async transferZones(): Promise<TransferZoneSummary[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const items = await this.tenantDb.db.item.findMany({
      where: { tenantId, deletedAt: null },
      select: { binLocation: true, quantity: true },
    });

    const zoneMap = new Map<
      string,
      { totalSkus: number; totalUnits: number }
    >();

    for (const item of items) {
      const zoneName =
        item.binLocation?.split('-')[0]?.trim() || 'Main Warehouse';
      const current = zoneMap.get(zoneName) ?? { totalSkus: 0, totalUnits: 0 };
      current.totalSkus += 1;
      current.totalUnits += item.quantity;
      zoneMap.set(zoneName, current);
    }

    const pendingByZone = await this.tenantDb.db.stockMovement.groupBy({
      by: ['notes'],
      where: {
        tenantId,
        deletedAt: null,
        type: 'transfer',
        status: 'Pending',
      },
      _count: { _all: true },
    });

    const pendingTotal = pendingByZone.reduce(
      (sum, row) => sum + row._count._all,
      0,
    );
    const zones = Array.from(zoneMap.entries());

    if (zones.length === 0) {
      return [
        {
          id: 'main',
          name: 'Main Warehouse',
          totalSkus: 0,
          totalUnits: 0,
          pendingTransfers: pendingTotal,
          utilizationPercent: 0,
        },
      ];
    }

    const maxUnits = Math.max(...zones.map(([, v]) => v.totalUnits), 1);

    return zones.map(([name, stats], index) => ({
      id: `zone_${index}`,
      name,
      totalSkus: stats.totalSkus,
      totalUnits: stats.totalUnits,
      pendingTransfers: Math.ceil(pendingTotal / zones.length),
      utilizationPercent: Math.round((stats.totalUnits / maxUnits) * 100),
    }));
  }
}
