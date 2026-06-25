import { Injectable, NotFoundException } from '@nestjs/common';
import type { Item, ItemFilters } from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { buildCursorQuery } from '../../common/utils/pagination';
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

  async list(filters: ItemFilters): Promise<Item[]> {
    const requestTenantId = this.tenantDb.requireTenantId();
    const tenantIds = await this.catalogTenantIds(requestTenantId);
    const limit = filters.limit ?? 50;

    const rows = await this.prisma.item.findMany({
      where: {
        tenantId: { in: tenantIds },
        deletedAt: null,
        availableForRetail: true,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { sku: { contains: filters.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      ...buildCursorQuery(filters.cursor, limit),
    });

    return rows.map(serializeItem);
  }

  async getById(id: string): Promise<Item> {
    const requestTenantId = this.tenantDb.requireTenantId();
    const tenantIds = await this.catalogTenantIds(requestTenantId);

    const row = await this.prisma.item.findFirst({
      where: {
        id,
        tenantId: { in: tenantIds },
        deletedAt: null,
        availableForRetail: true,
      },
    });
    if (!row) throw new NotFoundException('Catalog item not found');
    return serializeItem(row);
  }
}
