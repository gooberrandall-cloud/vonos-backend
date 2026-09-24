import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateVariationTemplateRequest,
  UpdateVariationTemplateRequest,
  VariationTemplate,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import { toIso } from '../../common/utils/serializers';

@Injectable()
export class VariationsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly cache: CacheService,
  ) {}

  private mapRow(row: {
    id: string;
    tenantId: string;
    name: string;
    values: string[];
    createdAt: Date;
    updatedAt: Date;
  }): VariationTemplate {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      values: row.values,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async list(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
  } = {}): Promise<VariationTemplate[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'variations',
      filterKey,
      () => this.listUncached(filters, tenantId),
    );
  }

  private async listUncached(
    filters: {
      cursor?: string;
      limit?: number;
      search?: string;
    },
    tenantId: string,
  ): Promise<VariationTemplate[]> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'updatedAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.tenantDb.db.variationTemplate.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    return rows.map((row) => this.mapRow(row));
  }

  async create(dto: CreateVariationTemplateRequest): Promise<VariationTemplate> {
    const tenantId = this.tenantDb.requireTenantId();
    const values = dto.values.map((v) => v.trim()).filter(Boolean);
    const row = await this.tenantDb.db.variationTemplate.create({
      data: {
        tenantId,
        name: dto.name.trim(),
        values,
      },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return this.mapRow(row);
  }

  async update(
    id: string,
    dto: UpdateVariationTemplateRequest,
  ): Promise<VariationTemplate> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.variationTemplate.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Variation template not found');

    const row = await this.tenantDb.db.variationTemplate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.values !== undefined
          ? { values: dto.values.map((v) => v.trim()).filter(Boolean) }
          : {}),
      },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return this.mapRow(row);
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.variationTemplate.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Variation template not found');
    await this.tenantDb.db.variationTemplate.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
  }
}
