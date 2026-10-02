import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateDiscountRequest,
  Discount,
  UpdateDiscountRequest,
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
export class DiscountsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly cache: CacheService,
  ) {}

  private mapRow(row: {
    id: string;
    tenantId: string;
    name: string;
    discountType: string;
    amount: { toString(): string };
    isActive: boolean;
    startsAt: Date | null;
    endsAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Discount {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      discountType: row.discountType as Discount['discountType'],
      amount: toNumber(row.amount),
      isActive: row.isActive,
      startsAt: row.startsAt ? toIso(row.startsAt) : null,
      endsAt: row.endsAt ? toIso(row.endsAt) : null,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async list(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
  } = {}): Promise<Discount[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'discounts',
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
  ): Promise<Discount[]> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'updatedAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.tenantDb.db.discount.findMany({
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

  async create(dto: CreateDiscountRequest): Promise<Discount> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.discount.create({
      data: {
        tenantId,
        name: dto.name.trim(),
        discountType: dto.discountType,
        amount: dto.amount,
        isActive: dto.isActive ?? true,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return this.mapRow(row);
  }

  async update(id: string, dto: UpdateDiscountRequest): Promise<Discount> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.discount.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Discount not found');

    const row = await this.tenantDb.db.discount.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.discountType !== undefined
          ? { discountType: dto.discountType }
          : {}),
        ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.startsAt !== undefined
          ? { startsAt: dto.startsAt ? new Date(dto.startsAt) : null }
          : {}),
        ...(dto.endsAt !== undefined
          ? { endsAt: dto.endsAt ? new Date(dto.endsAt) : null }
          : {}),
      },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return this.mapRow(row);
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.discount.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Discount not found');
    await this.tenantDb.db.discount.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
  }
}
