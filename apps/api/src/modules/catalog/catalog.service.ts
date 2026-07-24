import { Injectable, NotFoundException } from '@nestjs/common';
import type { Item, ItemFilters } from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  breakdownFromOnHand,
  reservedQtyBySku,
} from '../../common/utils/availableStock';
import { serializeItem } from '../items/items.mapper';

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
  ) {}

  /** Spare Shop catalog = local retail items + Warehouse (VW) items flagged for retail. */
  private async catalogTenantIds(requestTenantId: string): Promise<string[]> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: requestTenantId },
      select: { code: true },
    });
    const ids = new Set<string>([requestTenantId]);
    if (tenant?.code === 'VISP' || tenant?.code === 'VSP') {
      const warehouse = await this.prisma.tenant.findUnique({
        where: { code: 'VW' },
        select: { id: true },
      });
      if (warehouse) ids.add(warehouse.id);
    }
    return [...ids];
  }

  private async withAvailableQuantity(rows: Item[]): Promise<Item[]> {
    if (rows.length === 0) return rows;

    const byTenant = new Map<string, string[]>();
    for (const row of rows) {
      const list = byTenant.get(row.tenantId) ?? [];
      list.push(row.sku);
      byTenant.set(row.tenantId, list);
    }

    const reservedByTenant = new Map<string, Map<string, number>>();
    for (const [tenantId, skus] of byTenant) {
      reservedByTenant.set(
        tenantId,
        await reservedQtyBySku(this.prisma, tenantId, [...new Set(skus)]),
      );
    }

    return rows.map((row) => {
      const reserved =
        reservedByTenant.get(row.tenantId)?.get(row.sku.toUpperCase()) ?? 0;
      const { available } = breakdownFromOnHand(row.quantity, reserved);
      return { ...row, availableQuantity: available };
    });
  }

  async list(filters: ItemFilters): Promise<Item[]> {
    const requestTenantId = this.tenantDb.requireTenantId();
    const tenantIds = await this.catalogTenantIds(requestTenantId);
    const limit = filters.limit ?? 10;

    // Own-tenant items always appear. Cross-tenant (VW → VISP/VSP) stock
    // requires availableForRetail so warehouse can gate what retail sees.
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit,
      sortValueType: 'string',
    });
    const rows = await this.prisma.item.findMany({
      where: {
        tenantId: { in: tenantIds },
        deletedAt: null,
        OR: [
          { tenantId: requestTenantId },
          { availableForRetail: true },
        ],
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.unit
          ? { unit: { equals: filters.unit, mode: 'insensitive' as const } }
          : {}),
        ...(filters.brandName
          ? {
              brand: {
                name: {
                  equals: filters.brandName,
                  mode: 'insensitive' as const,
                },
              },
            }
          : {}),
        ...(filters.availableForRetail !== undefined
          ? { availableForRetail: filters.availableForRetail }
          : {}),
        ...(filters.locationCode || filters.search
          ? {
              AND: [
                ...(filters.locationCode
                  ? [
                      {
                        OR: [
                          { locationCode: filters.locationCode },
                          { binLocation: filters.locationCode },
                          {
                            locationStock: {
                              some: {
                                OR: [
                                  { locationCode: filters.locationCode },
                                  { binLocation: filters.locationCode },
                                ],
                              },
                            },
                          },
                        ],
                      },
                    ]
                  : []),
                ...(filters.search
                  ? [
                      {
                        OR: [
                          {
                            name: {
                              contains: filters.search,
                              mode: 'insensitive' as const,
                            },
                          },
                          {
                            sku: {
                              contains: filters.search,
                              mode: 'insensitive' as const,
                            },
                          },
                        ],
                      },
                    ]
                  : []),
              ],
            }
          : {}),
        ...(pagination.where ?? {}),
      },
      include: { brand: { select: { name: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });

    return this.withAvailableQuantity(rows.map(serializeItem));
  }

  async getById(id: string): Promise<Item> {
    const requestTenantId = this.tenantDb.requireTenantId();
    const tenantIds = await this.catalogTenantIds(requestTenantId);

    const row = await this.prisma.item.findFirst({
      where: {
        id,
        tenantId: { in: tenantIds },
        deletedAt: null,
        OR: [
          { tenantId: requestTenantId },
          { availableForRetail: true },
        ],
      },
    });
    if (!row) throw new NotFoundException('Catalog item not found');
    const [withAvailable] = await this.withAvailableQuantity([
      serializeItem(row),
    ]);
    return withAvailable!;
  }
}
