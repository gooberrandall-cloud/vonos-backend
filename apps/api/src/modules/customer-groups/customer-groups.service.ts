import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CustomerGroup,
  CreateCustomerGroupRequest,
  UpdateCustomerGroupRequest,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import { toIso, toNumber } from '../../common/utils/serializers';

@Injectable()
export class CustomerGroupsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly cache: CacheService,
  ) {}

  async list(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    discount?: 'has' | 'none';
  } = {}): Promise<CustomerGroup[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      discount: filters.discount,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'customer-groups',
      filterKey,
      () => this.listUncached(filters, tenantId),
    );
  }

  private async listUncached(
    filters: {
      cursor?: string;
      limit?: number;
      search?: string;
      discount?: 'has' | 'none';
    },
    tenantId: string,
  ): Promise<CustomerGroup[]> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'updatedAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.tenantDb.db.customerGroup.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(filters.discount === 'has'
          ? { discountPercent: { gt: 0 } }
          : filters.discount === 'none'
            ? { discountPercent: { lte: 0 } }
            : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      discountPercent: toNumber(row.discountPercent),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  }

  async create(dto: CreateCustomerGroupRequest): Promise<CustomerGroup> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.customerGroup.create({
      data: {
        tenantId,
        name: dto.name,
        discountPercent: dto.discountPercent ?? 0,
      },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      discountPercent: toNumber(row.discountPercent),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async update(
    id: string,
    dto: UpdateCustomerGroupRequest,
  ): Promise<CustomerGroup> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.customerGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Customer group not found');
    const row = await this.tenantDb.db.customerGroup.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.discountPercent !== undefined
          ? { discountPercent: dto.discountPercent }
          : {}),
      },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      discountPercent: toNumber(row.discountPercent),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.customerGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Customer group not found');
    await this.tenantDb.db.customerGroup.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
  }
}
