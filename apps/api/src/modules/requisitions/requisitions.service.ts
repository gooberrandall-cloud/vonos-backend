import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  Requisition,
  RequisitionLine,
  RequisitionStatus,
} from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { toIso } from '../../common/utils/serializers';
import { computeStockStatus, movementLineRollups } from '../../common/utils/stockQuantity';
import { adjustItemLocationStock } from '../../common/utils/itemLocationStock';
import {
  assertSourceHasAvailableStock,
  reservedQtyBySku,
  breakdownFromOnHand,
} from '../../common/utils/availableStock';

/** Default fulfilling entity for the warehouse-first workflow. */
const DEFAULT_SOURCE_CODE = 'VW';

function parseLines(value: unknown): RequisitionLine[] {
  if (!Array.isArray(value)) return [];
  const result: RequisitionLine[] = [];
  for (const raw of value) {
    const line = raw as Partial<RequisitionLine>;
    const sku = typeof line.sku === 'string' ? line.sku : '';
    const quantity = Number(line.quantity) || 0;
    if (!sku || quantity <= 0) continue;
    result.push({
      itemId: line.itemId ?? null,
      sku,
      name: typeof line.name === 'string' ? line.name : sku,
      quantity,
    });
  }
  return result;
}

function serialize(row: {
  id: string;
  tenantId: string;
  reference: string;
  status: string;
  jobId: string | null;
  notes: string | null;
  sourceTenantId: string | null;
  lines: unknown;
  fulfilledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): Requisition {
  return {
    id: row.id,
    tenantId: row.tenantId,
    reference: row.reference,
    status: row.status as RequisitionStatus,
    jobId: row.jobId,
    notes: row.notes,
    sourceTenantId: row.sourceTenantId,
    lines: parseLines(row.lines),
    fulfilledAt: row.fulfilledAt ? toIso(row.fulfilledAt) : null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

@Injectable()
export class RequisitionsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /** Requisitions where this tenant is the fulfilment source (e.g. Warehouse inbox). */
  async listIncoming(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
  } = {}): Promise<Requisition[]> {
    const sourceTenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'createdAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.prisma.requisition.findMany({
      where: {
        sourceTenantId,
        deletedAt: null,
        ...(filters.search
          ? {
              OR: [
                {
                  reference: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
                {
                  notes: { contains: filters.search, mode: 'insensitive' },
                },
              ],
            }
          : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    return rows.map(serialize);
  }

  async list(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
  } = {}): Promise<Requisition[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'createdAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.tenantDb.db.requisition.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? {
              OR: [
                {
                  reference: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
                {
                  notes: { contains: filters.search, mode: 'insensitive' },
                },
              ],
            }
          : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    return rows.map(serialize);
  }

  /**
   * Readable by requesting tenant or source (fulfilling) tenant.
   * Fixes Warehouse detail for incoming requisitions.
   */
  async getById(id: string): Promise<Requisition> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.prisma.requisition.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [{ tenantId }, { sourceTenantId: tenantId }],
      },
    });
    if (!row) throw new NotFoundException('Requisition not found');
    return serialize(row);
  }

  async create(body: {
    reference: string;
    jobId?: string;
    notes?: string;
    sourceTenantCode?: string;
    lines?: RequisitionLine[];
  }): Promise<Requisition> {
    const tenantId = this.tenantDb.requireTenantId();
    const sourceTenantId = await this.resolveSourceTenantId(
      body.sourceTenantCode ?? DEFAULT_SOURCE_CODE,
    );
    const lines = parseLines(body.lines);
    const row = await this.tenantDb.db.requisition.create({
      data: {
        tenantId,
        reference: body.reference,
        status: 'Pending',
        jobId: body.jobId ?? null,
        notes: body.notes ?? null,
        sourceTenantId,
        lines:
          lines.length > 0
            ? (lines as unknown as Prisma.InputJsonValue)
            : undefined,
      },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'requisition',
      entityId: row.id,
      summary: `Created requisition ${row.reference}`,
    });
    return serialize(row);
  }

  /** Requesting tenant cancels a Pending requisition only. */
  async cancel(id: string): Promise<Requisition> {
    const requestingTenantId = this.tenantDb.requireTenantId();
    const existing = await this.prisma.requisition.findFirst({
      where: { id, tenantId: requestingTenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Requisition not found');
    if (existing.status !== 'Pending') {
      throw new BadRequestException(
        'Only Pending requisitions can be cancelled',
      );
    }
    await this.prisma.requisition.update({
      where: { id },
      data: { status: 'Cancelled' },
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'requisition',
      entityId: id,
      summary: `Status → Cancelled`,
      metadata: { previousStatus: existing.status, status: 'Cancelled' },
    });
    return this.getById(id);
  }

  /** Source tenant approves Pending → Approved after available-stock check. */
  async approve(id: string): Promise<Requisition> {
    const sourceTenantId = this.tenantDb.requireTenantId();
    const existing = await this.findIncoming(id, sourceTenantId);
    if (existing.status !== 'Pending') {
      throw new BadRequestException(
        'Requisition must be Pending to become Approved',
      );
    }
    const lines = parseLines(existing.lines);
    try {
      await assertSourceHasAvailableStock(this.prisma, sourceTenantId, lines);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Insufficient available stock',
      );
    }
    await this.prisma.requisition.update({
      where: { id },
      data: { status: 'Approved' },
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'requisition',
      entityId: id,
      summary: `Status → Approved`,
      metadata: { previousStatus: existing.status, status: 'Approved' },
    });
    return this.getById(id);
  }

  /** Source tenant rejects Pending → Rejected. */
  async reject(id: string): Promise<Requisition> {
    const sourceTenantId = this.tenantDb.requireTenantId();
    const existing = await this.findIncoming(id, sourceTenantId);
    if (existing.status !== 'Pending') {
      throw new BadRequestException(
        'Requisition must be Pending to become Rejected',
      );
    }
    await this.prisma.requisition.update({
      where: { id },
      data: { status: 'Rejected' },
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'requisition',
      entityId: id,
      summary: `Status → Rejected`,
      metadata: { previousStatus: existing.status, status: 'Rejected' },
    });
    return this.getById(id);
  }

  /**
   * Source tenant fulfils Approved requisition: decrement source stock,
   * increment requesting tenant stock. Stock-only — no money ledger.
   */
  async fulfill(id: string): Promise<Requisition> {
    const sourceTenantId = this.tenantDb.requireTenantId();
    const requisition = await this.findIncoming(id, sourceTenantId);

    if (requisition.status === 'Fulfilled') {
      throw new BadRequestException('Requisition already fulfilled');
    }
    if (requisition.status !== 'Approved') {
      throw new BadRequestException(
        'Requisition must be Approved before fulfilment',
      );
    }

    const lines = parseLines(requisition.lines);
    if (lines.length === 0) {
      throw new BadRequestException('Requisition has no line items to transfer');
    }

    const requestingTenantId = requisition.tenantId;
    if (sourceTenantId === requestingTenantId) {
      throw new BadRequestException(
        'Source and requesting entity must be different',
      );
    }

    // Physical on-hand must cover the transfer (hold already counted in reserved).
    await this.assertSourceHasOnHand(sourceTenantId, lines);

    const movementLines = lines.map((line) => ({
      itemId: line.itemId ?? '',
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
    }));

    await this.prisma.$transaction(async (tx) => {
      for (const line of lines) {
        const sourceItem = await tx.item.findFirst({
          where: { tenantId: sourceTenantId, sku: line.sku, deletedAt: null },
        });
        if (!sourceItem) {
          throw new BadRequestException(
            `Source entity has no item with SKU ${line.sku}. Use external procurement instead.`,
          );
        }

        const sourceNext = sourceItem.quantity - line.quantity;
        if (sourceNext < 0) {
          throw new BadRequestException(
            `Insufficient on-hand stock for SKU ${line.sku}: need ${line.quantity}, on hand ${sourceItem.quantity}`,
          );
        }
        await tx.item.update({
          where: { id: sourceItem.id },
          data: {
            quantity: sourceNext,
            status: computeStockStatus(sourceNext, sourceItem.reorderPoint),
          },
        });
        await adjustItemLocationStock(tx, {
          tenantId: sourceTenantId,
          itemId: sourceItem.id,
          locationCode: sourceItem.locationCode,
          binLocation: sourceItem.binLocation,
          delta: -line.quantity,
        });

        let destItem = await tx.item.findFirst({
          where: {
            tenantId: requestingTenantId,
            sku: line.sku,
            deletedAt: null,
          },
        });
        if (!destItem) {
          destItem = await tx.item.create({
            data: {
              tenantId: requestingTenantId,
              sku: line.sku,
              name: line.name || sourceItem.name,
              category: sourceItem.category,
              quantity: 0,
              costPrice: sourceItem.costPrice,
              currency: sourceItem.currency,
              reorderPoint: sourceItem.reorderPoint,
            },
          });
        }

        const destNext = destItem.quantity + line.quantity;
        await tx.item.update({
          where: { id: destItem.id },
          data: {
            quantity: destNext,
            status: computeStockStatus(destNext, destItem.reorderPoint),
          },
        });
        await adjustItemLocationStock(tx, {
          tenantId: requestingTenantId,
          itemId: destItem.id,
          locationCode: destItem.locationCode,
          binLocation: destItem.binLocation,
          delta: line.quantity,
        });
      }

      const now = new Date();
      const transferRollups = movementLineRollups(movementLines);
      await tx.stockMovement.create({
        data: {
          tenantId: sourceTenantId,
          type: 'outbound',
          reference: `${requisition.reference}-OUT`,
          status: 'Received',
          lines: movementLines,
          itemCount: transferRollups.itemCount,
          grandTotal: transferRollups.grandTotal,
          notes: `Transfer for requisition ${requisition.reference}`,
          date: now,
        },
      });
      await tx.stockMovement.create({
        data: {
          tenantId: requestingTenantId,
          type: 'inbound',
          reference: `${requisition.reference}-IN`,
          status: 'Received',
          lines: movementLines,
          itemCount: transferRollups.itemCount,
          grandTotal: transferRollups.grandTotal,
          notes: `Transfer from source for requisition ${requisition.reference}`,
          date: now,
        },
      });

      await tx.requisition.update({
        where: { id: requisition.id },
        data: {
          status: 'Fulfilled',
          sourceTenantId,
          fulfilledAt: now,
        },
      });
    });

    await this.auditService.log({
      action: 'updated',
      entityType: 'requisition',
      entityId: requisition.id,
      summary: `Fulfilled requisition ${requisition.reference}`,
      metadata: { sourceTenantId, lineCount: lines.length },
    });

    return this.getById(id);
  }

  private async findIncoming(id: string, sourceTenantId: string) {
    const row = await this.prisma.requisition.findFirst({
      where: { id, sourceTenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Requisition not found');
    return row;
  }

  /** Ensure physical on-hand covers requested qty (for fulfill). */
  private async assertSourceHasOnHand(
    sourceTenantId: string,
    lines: RequisitionLine[],
  ): Promise<void> {
    const skus = [...new Set(lines.map((l) => l.sku))];
    const items = await this.prisma.item.findMany({
      where: {
        tenantId: sourceTenantId,
        deletedAt: null,
        sku: { in: skus },
      },
      select: { sku: true, quantity: true },
    });
    const onHandBySku = new Map(
      items.map((item) => [item.sku.toUpperCase(), item.quantity]),
    );
    const reservedMap = await reservedQtyBySku(
      this.prisma,
      sourceTenantId,
      skus,
    );

    const requestedBySku = new Map<string, number>();
    for (const line of lines) {
      const key = line.sku.toUpperCase();
      requestedBySku.set(key, (requestedBySku.get(key) ?? 0) + line.quantity);
    }

    for (const [sku, requested] of requestedBySku) {
      const onHand = onHandBySku.get(sku) ?? 0;
      if (requested > onHand) {
        const reserved = reservedMap.get(sku) ?? 0;
        const { available } = breakdownFromOnHand(onHand, reserved);
        throw new BadRequestException(
          `Insufficient on-hand stock for SKU ${sku}: need ${requested}, on hand ${onHand} (available ${available}, reserved ${reserved})`,
        );
      }
    }
  }

  private async resolveSourceTenantId(code: string): Promise<string | null> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { code, deletedAt: null },
      select: { id: true },
    });
    return tenant?.id ?? null;
  }
}
