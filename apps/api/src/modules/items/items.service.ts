import { Injectable, NotFoundException } from '@nestjs/common';
import type { Item, ItemFilters, KpiSummary, StockStatus } from '@vonos/types';
import { Prisma } from '@prisma/client';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { buildCursorQuery } from '../../common/utils/pagination';
import { toNumber } from '../../common/utils/serializers';
import { serializeItem } from './items.mapper';

interface CreateItemDto {
  sku: string;
  name: string;
  category?: string;
  quantity?: number;
  binLocation?: string;
  locationCode?: string;
  reorderPoint?: number;
  costPrice: number;
  currency?: string;
  status?: StockStatus;
  availableForRetail?: boolean;
}

type UpdateItemDto = Partial<CreateItemDto>;

@Injectable()
export class ItemsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    filters: ItemFilters & { availableForRetail?: boolean },
  ): Promise<Item[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const db = this.tenantDb.db;
    const limit = filters.limit ?? 50;

    const rows = await db.item.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.availableForRetail !== undefined
          ? { availableForRetail: filters.availableForRetail }
          : {}),
        ...(filters.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { sku: { contains: filters.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      ...buildCursorQuery(filters.cursor, limit),
    });

    return rows.map(serializeItem);
  }

  async getById(id: string): Promise<Item> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.item.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Item not found');
    return serializeItem(row);
  }

  async kpiSummary(): Promise<KpiSummary> {
    const tenantId = this.tenantDb.requireTenantId();
    const db = this.tenantDb.db;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const itemWhere = { tenantId, deletedAt: null };

    const [totalSku, stockValueRows, currencyRow, todayInbound, todayOutbound] =
      await Promise.all([
        db.item.count({ where: itemWhere }),
        db.$queryRaw<[{ stock_value: Prisma.Decimal | null }]>`
        SELECT COALESCE(SUM(quantity * "costPrice"), 0) AS stock_value
        FROM "Item"
        WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
      `,
        db.item.findFirst({
          where: itemWhere,
          select: { currency: true },
          orderBy: { id: 'asc' },
        }),
        db.stockMovement.count({
          where: {
            tenantId,
            deletedAt: null,
            type: 'inbound',
            date: { gte: startOfDay, lte: endOfDay },
          },
        }),
        db.stockMovement.count({
          where: {
            tenantId,
            deletedAt: null,
            type: 'outbound',
            date: { gte: startOfDay, lte: endOfDay },
          },
        }),
      ]);

    const currency = currencyRow?.currency ?? 'NGN';
    const stockValue = toNumber(stockValueRows[0]?.stock_value ?? 0);

    return {
      totalSku,
      todayInbound,
      todayOutbound,
      stockValue,
      currency,
    };
  }

  async create(dto: CreateItemDto): Promise<Item> {
    const tenantId = this.tenantDb.requireTenantId();
    const createdBy = await this.auditService.createdByFields();
    const locationCode = await this.tenantDb.resolveBusinessLocation(
      dto.locationCode,
    );
    const row = await this.tenantDb.db.item.create({
      data: {
        tenantId,
        sku: dto.sku,
        name: dto.name,
        category: dto.category ?? null,
        quantity: dto.quantity ?? 0,
        binLocation: dto.binLocation ?? null,
        locationCode,
        reorderPoint: dto.reorderPoint ?? null,
        costPrice: dto.costPrice,
        currency: dto.currency ?? 'NGN',
        status: dto.status ?? 'in_stock',
        availableForRetail: dto.availableForRetail ?? false,
        ...createdBy,
      },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'item',
      entityId: row.id,
      summary: `Created item ${row.sku}`,
    });
    return serializeItem(row);
  }

  async update(id: string, dto: UpdateItemDto): Promise<Item> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.item.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Item not found');

    const resolvedLocation =
      dto.locationCode !== undefined
        ? await this.tenantDb.resolveBusinessLocation(dto.locationCode)
        : undefined;

    const row = await this.tenantDb.db.item.update({
      where: { id },
      data: {
        ...(dto.sku !== undefined ? { sku: dto.sku } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
        ...(dto.binLocation !== undefined
          ? { binLocation: dto.binLocation }
          : {}),
        ...(resolvedLocation !== undefined
          ? { locationCode: resolvedLocation }
          : {}),
        ...(dto.reorderPoint !== undefined
          ? { reorderPoint: dto.reorderPoint }
          : {}),
        ...(dto.costPrice !== undefined ? { costPrice: dto.costPrice } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.availableForRetail !== undefined
          ? { availableForRetail: dto.availableForRetail }
          : {}),
      },
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'item',
      entityId: id,
      summary: `Updated item ${row.sku}`,
    });
    return serializeItem(row);
  }
}
