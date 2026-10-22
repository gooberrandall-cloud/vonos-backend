import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Brand,
  CreateBrandInput,
  CreateProductCategoryInput,
  CreateProductUnitInput,
  CreateSellingPriceGroupInput,
  CreateWarrantyInput,
  ProductCategory,
  ProductUnit,
  SellingPriceGroup,
  Warranty,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import { toIso } from '../../common/utils/serializers';

const WARRANTY_DURATION_TYPES = new Set(['days', 'months', 'years']);

type MetaListFilters = {
  cursor?: string;
  limit?: number;
  search?: string;
};

function isPaginated(filters: MetaListFilters): boolean {
  return filters.cursor !== undefined || filters.limit !== undefined;
}

function metaPagination(filters: MetaListFilters) {
  if (!isPaginated(filters)) return { where: undefined, take: undefined };
  return buildCompositeCursorQuery({
      sortField: 'updatedAt',
      sortDir: 'desc',
    cursor: filters.cursor,
    limit: filters.limit ?? 10,
    sortValueType: 'date',
  });
}

function requireName(name: string | undefined, label = 'Name'): string {
  const trimmed = name?.trim() ?? '';
  if (!trimmed) throw new BadRequestException(`${label} is required`);
  return trimmed;
}

@Injectable()
export class CatalogMetaService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly cache: CacheService,
  ) {}

  private async invalidateMetaCache(kind: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    // Drop legacy full-list keys + bump version so withListPageCache pages miss.
    await Promise.all([
      this.cache.invalidatePrefix(`catalog-meta:${tenantId}:${kind}`),
      this.cache.bumpTenantVersion(tenantId),
    ]);
  }

  private metaListFilterKey(filters: MetaListFilters): string {
    return listPageFilterKey({
      search: filters.search,
      cursor: filters.cursor,
      limit: isPaginated(filters) ? (filters.limit ?? 10) : 'all',
    });
  }

  async listCategories(filters: MetaListFilters = {}): Promise<ProductCategory[]> {
    const tenantId = this.tenantDb.requireTenantId();
    return withListPageCache(
      this.cache,
      tenantId,
      'catalog-meta-categories',
      this.metaListFilterKey(filters),
      () => this.listCategoriesUncached(filters, tenantId),
    );
  }

  private async listCategoriesUncached(
    filters: MetaListFilters,
    tenantId: string,
  ): Promise<ProductCategory[]> {
    const rows = await this.tenantDb.db.productCategory.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(metaPagination(filters).where ?? {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: metaPagination(filters).take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      shortCode: row.shortCode,
      parentId: row.parentId,
      categoryType: row.categoryType,
      description: row.description,
      slug: row.slug,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  }

  async createCategory(
    body: CreateProductCategoryInput,
  ): Promise<ProductCategory> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = requireName(body.name);
    const row = await this.tenantDb.db.productCategory.create({
      data: {
        tenantId,
        name,
        shortCode: body.shortCode?.trim() || null,
        description: body.description?.trim() || null,
        categoryType: body.categoryType?.trim() || null,
      },
    });
    await this.invalidateMetaCache('categories');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      shortCode: row.shortCode,
      parentId: row.parentId,
      categoryType: row.categoryType,
      description: row.description,
      slug: row.slug,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async listBrands(filters: MetaListFilters = {}): Promise<Brand[]> {
    const tenantId = this.tenantDb.requireTenantId();
    return withListPageCache(
      this.cache,
      tenantId,
      'catalog-meta-brands',
      this.metaListFilterKey(filters),
      () => this.listBrandsUncached(filters, tenantId),
    );
  }

  private async listBrandsUncached(
    filters: MetaListFilters,
    tenantId: string,
  ): Promise<Brand[]> {
    const rows = await this.tenantDb.db.brand.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(metaPagination(filters).where ?? {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: metaPagination(filters).take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  }

  async createBrand(body: CreateBrandInput): Promise<Brand> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = requireName(body.name);
    const row = await this.tenantDb.db.brand.create({
      data: {
        tenantId,
        name,
        description: body.description?.trim() || null,
      },
    });
    await this.invalidateMetaCache('brands');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async listUnits(filters: MetaListFilters = {}): Promise<ProductUnit[]> {
    const tenantId = this.tenantDb.requireTenantId();
    return withListPageCache(
      this.cache,
      tenantId,
      'catalog-meta-units',
      this.metaListFilterKey(filters),
      () => this.listUnitsUncached(filters, tenantId),
    );
  }

  private async listUnitsUncached(
    filters: MetaListFilters,
    tenantId: string,
  ): Promise<ProductUnit[]> {
    const rows = await this.tenantDb.db.productUnit.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(metaPagination(filters).where ?? {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: metaPagination(filters).take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      shortName: row.shortName,
      allowDecimal: row.allowDecimal,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  }

  async createUnit(body: CreateProductUnitInput): Promise<ProductUnit> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = requireName(body.name);
    const shortName = requireName(body.shortName, 'Short name');
    const row = await this.tenantDb.db.productUnit.create({
      data: {
        tenantId,
        name,
        shortName,
        allowDecimal: Boolean(body.allowDecimal),
      },
    });
    await this.invalidateMetaCache('units');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      shortName: row.shortName,
      allowDecimal: row.allowDecimal,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async listWarranties(filters: MetaListFilters = {}): Promise<Warranty[]> {
    const tenantId = this.tenantDb.requireTenantId();
    return withListPageCache(
      this.cache,
      tenantId,
      'catalog-meta-warranties',
      this.metaListFilterKey(filters),
      () => this.listWarrantiesUncached(filters, tenantId),
    );
  }

  private async listWarrantiesUncached(
    filters: MetaListFilters,
    tenantId: string,
  ): Promise<Warranty[]> {
    const rows = await this.tenantDb.db.warranty.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(metaPagination(filters).where ?? {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: metaPagination(filters).take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      duration: row.duration,
      durationType: row.durationType as Warranty['durationType'],
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  }

  async createWarranty(body: CreateWarrantyInput): Promise<Warranty> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = requireName(body.name);
    const duration = Number(body.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new BadRequestException('Duration must be a positive number');
    }
    if (!WARRANTY_DURATION_TYPES.has(body.durationType)) {
      throw new BadRequestException('Duration type must be days, months, or years');
    }
    const row = await this.tenantDb.db.warranty.create({
      data: {
        tenantId,
        name,
        duration: Math.floor(duration),
        durationType: body.durationType,
        description: body.description?.trim() || null,
      },
    });
    await this.invalidateMetaCache('warranties');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      duration: row.duration,
      durationType: row.durationType as Warranty['durationType'],
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async listPriceGroups(
    filters: MetaListFilters = {},
  ): Promise<SellingPriceGroup[]> {
    const tenantId = this.tenantDb.requireTenantId();
    return withListPageCache(
      this.cache,
      tenantId,
      'catalog-meta-price-groups',
      this.metaListFilterKey(filters),
      () => this.listPriceGroupsUncached(filters, tenantId),
    );
  }

  private async listPriceGroupsUncached(
    filters: MetaListFilters,
    tenantId: string,
  ): Promise<SellingPriceGroup[]> {
    const rows = await this.tenantDb.db.sellingPriceGroup.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(metaPagination(filters).where ?? {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: metaPagination(filters).take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      isActive: row.isActive,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  }

  async createPriceGroup(
    body: CreateSellingPriceGroupInput,
  ): Promise<SellingPriceGroup> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = requireName(body.name);
    const row = await this.tenantDb.db.sellingPriceGroup.create({
      data: {
        tenantId,
        name,
        description: body.description?.trim() || null,
        isActive: body.isActive ?? true,
      },
    });
    await this.invalidateMetaCache('price-groups');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      isActive: row.isActive,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async updateCategory(
    id: string,
    body: { name?: string; shortCode?: string | null; description?: string | null },
  ): Promise<ProductCategory> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.productCategory.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Category not found');
    const row = await this.tenantDb.db.productCategory.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: requireName(body.name) } : {}),
        ...(body.shortCode !== undefined
          ? { shortCode: body.shortCode?.trim() || null }
          : {}),
        ...(body.description !== undefined
          ? { description: body.description?.trim() || null }
          : {}),
      },
    });
    await this.invalidateMetaCache('categories');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      shortCode: row.shortCode,
      parentId: row.parentId,
      categoryType: row.categoryType,
      description: row.description,
      slug: row.slug,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async removeCategory(id: string): Promise<void> {
    await this.softDeleteMeta('productCategory', id, 'categories');
  }

  async updateBrand(
    id: string,
    body: { name?: string; description?: string | null },
  ): Promise<Brand> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.brand.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Brand not found');
    const row = await this.tenantDb.db.brand.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: requireName(body.name) } : {}),
        ...(body.description !== undefined
          ? { description: body.description?.trim() || null }
          : {}),
      },
    });
    await this.invalidateMetaCache('brands');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async removeBrand(id: string): Promise<void> {
    await this.softDeleteMeta('brand', id, 'brands');
  }

  async updateUnit(
    id: string,
    body: { name?: string; shortName?: string; allowDecimal?: boolean },
  ): Promise<ProductUnit> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.productUnit.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Unit not found');
    const row = await this.tenantDb.db.productUnit.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: requireName(body.name) } : {}),
        ...(body.shortName !== undefined
          ? { shortName: requireName(body.shortName, 'Short name') }
          : {}),
        ...(body.allowDecimal !== undefined
          ? { allowDecimal: Boolean(body.allowDecimal) }
          : {}),
      },
    });
    await this.invalidateMetaCache('units');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      shortName: row.shortName,
      allowDecimal: row.allowDecimal,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async removeUnit(id: string): Promise<void> {
    await this.softDeleteMeta('productUnit', id, 'units');
  }

  async updateWarranty(
    id: string,
    body: {
      name?: string;
      description?: string | null;
      duration?: number;
      durationType?: Warranty['durationType'];
    },
  ): Promise<Warranty> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.warranty.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Warranty not found');
    if (
      body.durationType !== undefined &&
      !WARRANTY_DURATION_TYPES.has(body.durationType)
    ) {
      throw new BadRequestException('Duration type must be days, months, or years');
    }
    const row = await this.tenantDb.db.warranty.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: requireName(body.name) } : {}),
        ...(body.description !== undefined
          ? { description: body.description?.trim() || null }
          : {}),
        ...(body.duration !== undefined
          ? { duration: Math.floor(Number(body.duration)) }
          : {}),
        ...(body.durationType !== undefined
          ? { durationType: body.durationType }
          : {}),
      },
    });
    await this.invalidateMetaCache('warranties');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      duration: row.duration,
      durationType: row.durationType as Warranty['durationType'],
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async removeWarranty(id: string): Promise<void> {
    await this.softDeleteMeta('warranty', id, 'warranties');
  }

  async updatePriceGroup(
    id: string,
    body: { name?: string; description?: string | null; isActive?: boolean },
  ): Promise<SellingPriceGroup> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.sellingPriceGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Price group not found');
    const row = await this.tenantDb.db.sellingPriceGroup.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: requireName(body.name) } : {}),
        ...(body.description !== undefined
          ? { description: body.description?.trim() || null }
          : {}),
        ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
      },
    });
    await this.invalidateMetaCache('price-groups');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      isActive: row.isActive,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async removePriceGroup(id: string): Promise<void> {
    await this.softDeleteMeta('sellingPriceGroup', id, 'price-groups');
  }

  private async softDeleteMeta(
    model: 'productCategory' | 'brand' | 'productUnit' | 'warranty' | 'sellingPriceGroup',
    id: string,
    cacheKind: string,
  ): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const db = this.tenantDb.db;
    const where = { id, tenantId, deletedAt: null };
    let existing: { id: string } | null = null;
    switch (model) {
      case 'productCategory':
        existing = await db.productCategory.findFirst({ where, select: { id: true } });
        if (!existing) throw new NotFoundException('Record not found');
        await db.productCategory.update({ where: { id }, data: { deletedAt: new Date() } });
        break;
      case 'brand':
        existing = await db.brand.findFirst({ where, select: { id: true } });
        if (!existing) throw new NotFoundException('Record not found');
        await db.brand.update({ where: { id }, data: { deletedAt: new Date() } });
        break;
      case 'productUnit':
        existing = await db.productUnit.findFirst({ where, select: { id: true } });
        if (!existing) throw new NotFoundException('Record not found');
        await db.productUnit.update({ where: { id }, data: { deletedAt: new Date() } });
        break;
      case 'warranty':
        existing = await db.warranty.findFirst({ where, select: { id: true } });
        if (!existing) throw new NotFoundException('Record not found');
        await db.warranty.update({ where: { id }, data: { deletedAt: new Date() } });
        break;
      case 'sellingPriceGroup':
        existing = await db.sellingPriceGroup.findFirst({ where, select: { id: true } });
        if (!existing) throw new NotFoundException('Record not found');
        await db.sellingPriceGroup.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
        break;
      default: {
        const _exhaustive: never = model;
        return _exhaustive;
      }
    }
    await this.invalidateMetaCache(cacheKind);
  }
}
