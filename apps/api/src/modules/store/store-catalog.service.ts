import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  breakdownFromOnHand,
  reservedQtyBySku,
} from '../../common/utils/availableStock';
import { buildCompositeCursorQuery, nextCompositeCursor } from '../../common/utils/pagination';
import { isStrictStoreCatalog } from './store-catalog-mode';

/** Public shop catalog source — VSP marketplace only (not VISP). */
const STORE_TENANT_CODES = ['VSP'] as const;

export type PublicStoreProduct = {
  id: string;
  sku: string;
  name: string;
  category: string;
  description: string | null;
  price: number;
  currency: string;
  imageUrl: string | null;
  tenantCode: string;
  tenantId: string;
  availableQuantity: number;
  inStock: boolean;
};

export type PublicStoreCatalogPage = {
  items: PublicStoreProduct[];
  nextCursor: string | null;
  categories: string[];
  /** strict = production retail filters; testing = all priced VSP items */
  catalogMode: 'strict' | 'testing';
};

export type StoreCatalogSort =
  | 'newest'
  | 'price_asc'
  | 'price_desc'
  | 'name_asc';

@Injectable()
export class StoreCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  private async storeTenantIds(): Promise<Map<string, string>> {
    const tenants = await this.prisma.tenant.findMany({
      where: { code: { in: [...STORE_TENANT_CODES] }, deletedAt: null },
      select: { id: true, code: true },
    });
    return new Map(tenants.map((row) => [row.code, row.id]));
  }

  private catalogItemWhere(
    tenantIds: string[],
    extras: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const strict = isStrictStoreCatalog();
    return {
      tenantId: { in: tenantIds },
      deletedAt: null,
      sellPrice: { not: null },
      ...(strict
        ? {
            availableForRetail: true,
            status: { in: ['in_stock', 'low_stock'] },
          }
        : {}),
      ...extras,
    };
  }

  private resolveSort(sort?: string): {
    sortField: 'updatedAt' | 'sellPrice' | 'name';
    sortDir: 'asc' | 'desc';
    sortValueType: 'string' | 'date' | 'number';
  } {
    switch (sort) {
      case 'price_asc':
        return { sortField: 'sellPrice', sortDir: 'asc', sortValueType: 'number' };
      case 'price_desc':
        return { sortField: 'sellPrice', sortDir: 'desc', sortValueType: 'number' };
      case 'name_asc':
        return { sortField: 'name', sortDir: 'asc', sortValueType: 'string' };
      case 'newest':
        return { sortField: 'updatedAt', sortDir: 'desc', sortValueType: 'date' };
      default:
        return { sortField: 'updatedAt', sortDir: 'desc', sortValueType: 'date' };
    }
  }

  async listCatalog(args: {
    search?: string;
    category?: string;
    sort?: string;
    minPrice?: number;
    maxPrice?: number;
    cursor?: string;
    limit?: number;
  }): Promise<PublicStoreCatalogPage> {
    const limit = Math.min(Math.max(args.limit ?? 24, 1), 100);
    const tenantMap = await this.storeTenantIds();
    const tenantIds = [...tenantMap.values()];
    if (tenantIds.length === 0) {
      return {
        items: [],
        nextCursor: null,
        categories: [],
        catalogMode: isStrictStoreCatalog() ? 'strict' : 'testing',
      };
    }

    const search = args.search?.trim();
    const category = args.category?.trim();
    const { sortField, sortDir, sortValueType } = this.resolveSort(args.sort);
    const minPrice =
      typeof args.minPrice === 'number' && Number.isFinite(args.minPrice)
        ? args.minPrice
        : undefined;
    const maxPrice =
      typeof args.maxPrice === 'number' && Number.isFinite(args.maxPrice)
        ? args.maxPrice
        : undefined;

    const priceFilter =
      minPrice != null || maxPrice != null
        ? {
            sellPrice: {
              not: null,
              ...(minPrice != null ? { gte: minPrice } : {}),
              ...(maxPrice != null ? { lte: maxPrice } : {}),
            },
          }
        : {};

    const cursorQuery = buildCompositeCursorQuery({
      sortField,
      sortDir,
      cursor: args.cursor,
      limit: limit + 1,
      sortValueType,
    });

    const rows = await this.prisma.item.findMany({
      where: this.catalogItemWhere(tenantIds, {
        ...(category && category.toLowerCase() !== 'all'
          ? {
              category: { equals: category, mode: 'insensitive' as const },
            }
          : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { sku: { contains: search, mode: 'insensitive' as const } },
                { category: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...priceFilter,
        ...(cursorQuery.where ?? {}),
      }),
      orderBy: [{ [sortField]: sortDir }, { id: sortDir }],
      take: cursorQuery.take,
      select: {
        id: true,
        tenantId: true,
        sku: true,
        name: true,
        category: true,
        description: true,
        sellPrice: true,
        currency: true,
        imageUrl: true,
        quantity: true,
        updatedAt: true,
        tenant: { select: { code: true } },
        locationStock: { select: { quantity: true } },
      },
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const reservedByTenant = new Map<string, Map<string, number>>();
    for (const tenantId of tenantIds) {
      const skus = pageRows.filter((r) => r.tenantId === tenantId).map((r) => r.sku);
      reservedByTenant.set(
        tenantId,
        await reservedQtyBySku(this.prisma, tenantId, [...new Set(skus)]),
      );
    }

    const bySku = new Map<string, PublicStoreProduct>();
    for (const row of pageRows) {
      const skuKey = row.sku.trim().toUpperCase();
      const reserved =
        reservedByTenant.get(row.tenantId)?.get(skuKey) ?? 0;
      const onHand = Math.max(
        row.quantity,
        row.locationStock.reduce((sum, loc) => sum + loc.quantity, 0),
      );
      const { available } = breakdownFromOnHand(onHand, reserved);
      const product: PublicStoreProduct = {
        id: row.id,
        sku: row.sku,
        name: row.name,
        category: row.category ?? 'General',
        description: row.description,
        price: Number(row.sellPrice),
        currency: row.currency || 'NGN',
        imageUrl: row.imageUrl,
        tenantCode: row.tenant.code,
        tenantId: row.tenantId,
        availableQuantity: available,
        inStock: available > 0,
      };

      const existing = bySku.get(skuKey);
      if (!existing || product.availableQuantity > existing.availableQuantity) {
        bySku.set(skuKey, product);
      }
    }

    const categories = await this.prisma.item.findMany({
      where: this.catalogItemWhere(tenantIds, {
        category: { not: null },
      }),
      distinct: ['category'],
      select: { category: true },
      orderBy: { category: 'asc' },
    });

    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last
        ? nextCompositeCursor(
            {
              ...last,
              sellPrice: Number(last.sellPrice),
            },
            sortField,
            sortValueType,
          )
        : null;

    // Keep API order (Map insertion follows pageRows when no dupes; re-sort if needed)
    const items = pageRows
      .map((row) => bySku.get(row.sku.trim().toUpperCase()))
      .filter((item): item is PublicStoreProduct => Boolean(item))
      .filter((item, index, arr) => arr.findIndex((x) => x.id === item.id) === index);

    return {
      items,
      nextCursor,
      categories: categories
        .map((row) => row.category?.trim())
        .filter((value): value is string => Boolean(value)),
      catalogMode: isStrictStoreCatalog() ? 'strict' : 'testing',
    };
  }

  async getBySku(sku: string): Promise<PublicStoreProduct | null> {
    const tenantMap = await this.storeTenantIds();
    const tenantIds = [...tenantMap.values()];
    if (tenantIds.length === 0) return null;

    const normalized = sku.trim();
    const rows = await this.prisma.item.findMany({
      where: this.catalogItemWhere(tenantIds, {
        sku: { equals: normalized, mode: 'insensitive' },
      }),
      select: {
        id: true,
        tenantId: true,
        sku: true,
        name: true,
        category: true,
        description: true,
        sellPrice: true,
        currency: true,
        imageUrl: true,
        quantity: true,
        updatedAt: true,
        tenant: { select: { code: true } },
        locationStock: { select: { quantity: true } },
      },
    });

    if (rows.length === 0) return null;

    const preferred = rows[0];

    const reserved = await reservedQtyBySku(this.prisma, preferred.tenantId, [
      preferred.sku,
    ]);
    const onHand = Math.max(
      preferred.quantity,
      preferred.locationStock.reduce((sum, loc) => sum + loc.quantity, 0),
    );
    const { available } = breakdownFromOnHand(
      onHand,
      reserved.get(preferred.sku.toUpperCase()) ?? 0,
    );

    return {
      id: preferred.id,
      sku: preferred.sku,
      name: preferred.name,
      category: preferred.category ?? 'General',
      description: preferred.description,
      price: Number(preferred.sellPrice),
      currency: preferred.currency || 'NGN',
      imageUrl: preferred.imageUrl,
      tenantCode: preferred.tenant.code,
      tenantId: preferred.tenantId,
      availableQuantity: available,
      inStock: available > 0,
    };
  }

  async resolveCartLines(
    lines: Array<{ itemId: string; qty: number }>,
  ): Promise<
    Array<{
      itemId: string;
      tenantId: string;
      tenantCode: string;
      sku: string;
      name: string;
      qty: number;
      unitPrice: number;
      lineTotal: number;
      availableQuantity: number;
    }>
  > {
    if (lines.length === 0) return [];

    const tenantMap = await this.storeTenantIds();
    const tenantIds = [...tenantMap.values()];

    const itemIds = lines.map((line) => line.itemId);
    const items = await this.prisma.item.findMany({
      where: this.catalogItemWhere(tenantIds, {
        id: { in: itemIds },
      }),
      select: {
        id: true,
        tenantId: true,
        sku: true,
        name: true,
        sellPrice: true,
        quantity: true,
        tenant: { select: { code: true } },
        locationStock: { select: { quantity: true } },
      },
    });

    const itemMap = new Map(items.map((item) => [item.id, item]));
    const resolved = [];

    for (const line of lines) {
      const item = itemMap.get(line.itemId);
      if (!item) {
        throw new Error(`Item ${line.itemId} is not available in the store`);
      }
      const qty = Math.max(1, Math.floor(line.qty));
      const reserved = await reservedQtyBySku(this.prisma, item.tenantId, [item.sku]);
      const onHand = Math.max(
        item.quantity,
        item.locationStock.reduce((sum, loc) => sum + loc.quantity, 0),
      );
      const { available } = breakdownFromOnHand(
        onHand,
        reserved.get(item.sku.toUpperCase()) ?? 0,
      );
      if (qty > available) {
        throw new Error(`${item.name} only has ${available} available`);
      }
      const unitPrice = Number(item.sellPrice);
      resolved.push({
        itemId: item.id,
        tenantId: item.tenantId,
        tenantCode: item.tenant.code,
        sku: item.sku,
        name: item.name,
        qty,
        unitPrice,
        lineTotal: unitPrice * qty,
        availableQuantity: available,
      });
    }

    return resolved;
  }
}
