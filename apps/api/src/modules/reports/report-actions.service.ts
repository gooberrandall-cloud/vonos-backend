import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { computeStockStatus, parseMovementLines } from '../../common/utils/stockQuantity';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ReportActionsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * HQ6 `adjustProductStock` — set per-location quantity and re-sync item total.
   */
  async fixLocationStock(body: {
    itemId: string;
    locationCode: string;
    binLocation?: string;
    quantity: number;
  }) {
    const tenantId = this.tenantDb.requireTenantId();
    const db = this.tenantDb.db;
    const binLocation = body.binLocation?.trim() ?? '';
    const quantity = Math.max(0, Math.trunc(body.quantity));

    if (!body.itemId || !body.locationCode?.trim()) {
      throw new BadRequestException('itemId and locationCode are required');
    }

    const item = await db.item.findFirst({
      where: { id: body.itemId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Item not found');

    await db.$transaction(async (tx) => {
      const existing = await tx.itemLocationStock.findFirst({
        where: {
          itemId: body.itemId,
          locationCode: body.locationCode.trim(),
          binLocation,
        },
      });

      if (existing) {
        await tx.itemLocationStock.update({
          where: { id: existing.id },
          data: { quantity },
        });
      } else {
        await tx.itemLocationStock.create({
          data: {
            tenantId,
            itemId: body.itemId,
            locationCode: body.locationCode.trim(),
            binLocation,
            quantity,
          },
        });
      }

      const sum = await tx.itemLocationStock.aggregate({
        where: { itemId: body.itemId },
        _sum: { quantity: true },
      });
      const total = sum._sum.quantity ?? 0;
      await tx.item.update({
        where: { id: body.itemId },
        data: {
          quantity: total,
          status: computeStockStatus(total, item.reorderPoint),
        },
      });
    });

    await this.auditService.log({
      action: 'report.fix_location_stock',
      entityType: 'item',
      entityId: body.itemId,
      summary: `Fixed stock for ${item.sku} at ${body.locationCode} → ${quantity}`,
      metadata: body,
    });

    return { ok: true, itemId: body.itemId, quantity };
  }

  /**
   * HQ6 `updateStockExpiryReport` — expiry lives on inbound movement line JSON.
   */
  async updateMovementLineExpiry(body: {
    movementId: string;
    lineSku: string;
    expDate: string;
  }) {
    const db = this.tenantDb.db;
    const expDate = body.expDate.trim();
    if (!body.movementId || !body.lineSku || !expDate) {
      throw new BadRequestException(
        'movementId, lineSku, and expDate are required',
      );
    }

    const movement = await db.stockMovement.findFirst({
      where: { id: body.movementId, deletedAt: null, type: 'inbound' },
    });
    if (!movement) throw new NotFoundException('Inbound movement not found');

    const lines = parseMovementLines(movement.lines);
    const index = lines.findIndex((line) => line.sku === body.lineSku);
    if (index < 0) {
      throw new NotFoundException('Line not found on movement');
    }

    const rawLines = Array.isArray(movement.lines)
      ? [...(movement.lines as Record<string, unknown>[])]
      : [];
    const target = rawLines[index];
    if (!target || typeof target !== 'object') {
      throw new BadRequestException('Invalid movement line data');
    }

    rawLines[index] = { ...target, expDate };

    await db.stockMovement.update({
      where: { id: movement.id },
      data: { lines: rawLines as unknown as Prisma.InputJsonValue },
    });

    await this.auditService.log({
      action: 'report.update_line_expiry',
      entityType: 'stockMovement',
      entityId: movement.id,
      summary: `Updated expiry for ${body.lineSku} on ${movement.reference}`,
      metadata: body,
    });

    return { ok: true, movementId: movement.id, lineSku: body.lineSku, expDate };
  }
}
