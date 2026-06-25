import { Injectable } from '@nestjs/common';
import type {
  Brand,
  ProductCategory,
  ProductUnit,
  SellingPriceGroup,
  Warranty,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { toIso } from '../../common/utils/serializers';

@Injectable()
export class CatalogMetaService {
  constructor(private readonly tenantDb: TenantDbService) {}

  async listCategories(): Promise<ProductCategory[]> {
    const rows = await this.tenantDb.db.productCategory.findMany({
      where: { tenantId: this.tenantDb.requireTenantId(), deletedAt: null },
      orderBy: { name: 'asc' },
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

  async listBrands(): Promise<Brand[]> {
    const rows = await this.tenantDb.db.brand.findMany({
      where: { tenantId: this.tenantDb.requireTenantId(), deletedAt: null },
      orderBy: { name: 'asc' },
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

  async listUnits(): Promise<ProductUnit[]> {
    const rows = await this.tenantDb.db.productUnit.findMany({
      where: { tenantId: this.tenantDb.requireTenantId(), deletedAt: null },
      orderBy: { name: 'asc' },
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

  async listWarranties(): Promise<Warranty[]> {
    const rows = await this.tenantDb.db.warranty.findMany({
      where: { tenantId: this.tenantDb.requireTenantId(), deletedAt: null },
      orderBy: { name: 'asc' },
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

  async listPriceGroups(): Promise<SellingPriceGroup[]> {
    const rows = await this.tenantDb.db.sellingPriceGroup.findMany({
      where: { tenantId: this.tenantDb.requireTenantId(), deletedAt: null },
      orderBy: { name: 'asc' },
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
}
