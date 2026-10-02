import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  breakdownFromOnHand,
  reservedQtyBySku,
} from '../../common/utils/availableStock';
import { buildCompositeCursorQuery, nextCompositeCursor } from '../../common/utils/pagination';
import { isStrictStoreCatalog } from './store-catalog-mode';

/** Public shop catalog — VISP institute + VSP marketplace (consolidated by SKU). */
const STORE_TENANT_CODES = ['VISP', 'VSP'] as const;

/** Deduct / allocate stock from VISP before VSP. */
const STOCK_PRIORITY = ['VISP', 'VSP'] as const;

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
  /** strict = production retail filters; testing = all priced VISP/VSP items */
  catalogMode: 'strict' | 'testing';
};

export type StoreCatalogSort =
  | 'newest'
  | 'price_asc'
  | 'price_desc'
  | 'name_asc';

export type ResolvedStoreCartLine = {
  itemId: string;
  tenantId: string;
  tenantCode: string;
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  availableQuantity: number;
};

type CatalogItemRow = {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  category: string | null;
  description: string | null;
  sellPrice: { toString(): string } | number | null;
  currency: string | null;
  imageUrl: string | null;
  quantity: number;
  updatedAt: Date;
  tenant: { code: string };
  locationStock: Array<{ quantity: number }>;
};

@Injectable()
export class StoreCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  private async storeTenantIds(): Promise<Map<string, string>> {
    const tenants = await this.prisma.tenant.findMany({
      where: { code: { in: [...STORE_TENANT_CODES] }, deletedAt: null },
      select: { id: true, code: true },
    });
    const map = new Map(tenants.map((row) => [row.code, row.id]));
    // Stable VISP-then-VSP iteration for allocation.
    return map;
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

  private tenantPriority(code: string): number {
    const idx = (STOCK_PRIORITY as readonly string[]).indexOf(code);
    return idx === -1 ? 99 : idx;
  }

  private availableForRow(
    row: {
      quantity: number;
      locationStock: Array<{ quantity: number }>;
      sku: string;
      tenantId: string;
    },
    reservedByTenant: Map<string, Map<string, number>>,
  ): number {
    const skuKey = row.sku.trim().toUpperCase();
    const reserved = reservedByTenant.get(row.tenantId)?.get(skuKey) ?? 0;
    const onHand = Math.max(
      row.quantity,
      row.locationStock.reduce((sum, loc) => sum + loc.quantity, 0),
    );
    return breakdownFromOnHand(onHand, reserved).available;
  }

  /**
   * Merge same-SKU rows across VISP + VSP: sum available qty; prefer VISP
   * metadata (name/price/image/id) when present.
   */
  private consolidateBySku(
    rows: CatalogItemRow[],
    reservedByTenant: Map<string, Map<string, number>>,
  ): Map<string, PublicStoreProduct> {
    const bySku = new Map<
      string,
      { product: PublicStoreProduct; priority: number }
    >();

    for (const row of rows) {
      const skuKey = row.sku.trim().toUpperCase();
      const available = this.availableForRow(row, reservedByTenant);
      const priority = this.tenantPriority(row.tenant.code);
      const candidate: PublicStoreProduct = {
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
      if (!existing) {
        bySku.set(skuKey, { product: candidate, priority });
        continue;
      }

      const preferMeta = priority < existing.priority;
      const merged: PublicStoreProduct = {
        ...(preferMeta ? candidate : existing.product),
        availableQuantity:
          existing.product.availableQuantity + candidate.availableQuantity,
        inStock:
          existing.product.availableQuantity + candidate.availableQuantity > 0,
        // Keep preferred tenant ids on the display product.
        id: preferMeta ? candidate.id : existing.product.id,
        tenantCode: preferMeta ? candidate.tenantCode : existing.product.tenantCode,
        tenantId: preferMeta ? candidate.tenantId : existing.product.tenantId,
        name: preferMeta ? candidate.name : existing.product.name,
        category: preferMeta ? candidate.category : existing.product.category,
        description: preferMeta
          ? candidate.description
          : existing.product.description,
        price: preferMeta ? candidate.price : existing.product.price,
        currency: preferMeta ? candidate.currency : existing.product.currency,
        imageUrl: preferMeta ? candidate.imageUrl : existing.product.imageUrl,
        sku: existing.product.sku,
      };
      bySku.set(skuKey, {
        product: merged,
        priority: Math.min(existing.priority, priority),
      });
    }

    return new Map(
      [...bySku.entries()].map(([sku, entry]) => [sku, entry.product]),
    );
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

    // Re-fetch all tenant copies of SKUs on this page so qty sums are complete.
    const pageSkus = [...new Set(pageRows.map((r) => r.sku.trim()))];
    const siblingRows =
      pageSkus.length === 0
        ? []
        : await this.prisma.item.findMany({
            where: this.catalogItemWhere(tenantIds, {
              OR: pageSkus.map((sku) => ({
                sku: { equals: sku, mode: 'insensitive' as const },
              })),
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

    const reservedByTenant = new Map<string, Map<string, number>>();
    for (const tenantId of tenantIds) {
      const skus = siblingRows
        .filter((r) => r.tenantId === tenantId)
        .map((r) => r.sku);
      reservedByTenant.set(
        tenantId,
        await reservedQtyBySku(this.prisma, tenantId, [...new Set(skus)]),
      );
    }

    const bySku = this.consolidateBySku(siblingRows, reservedByTenant);

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

    const seen = new Set<string>();
    const items: PublicStoreProduct[] = [];
    for (const row of pageRows) {
      const skuKey = row.sku.trim().toUpperCase();
      if (seen.has(skuKey)) continue;
      const product = bySku.get(skuKey);
      if (!product) continue;
      seen.add(skuKey);
      items.push(product);
    }

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

    const reservedByTenant = new Map<string, Map<string, number>>();
    for (const tenantId of tenantIds) {
      const skus = rows.filter((r) => r.tenantId === tenantId).map((r) => r.sku);
      reservedByTenant.set(
        tenantId,
        await reservedQtyBySku(this.prisma, tenantId, [...new Set(skus)]),
      );
    }

    const bySku = this.consolidateBySku(rows, reservedByTenant);
    return bySku.get(rows[0]!.sku.trim().toUpperCase()) ?? null;
  }

  /**
   * Resolve cart lines by SKU across VISP + VSP, allocating qty VISP-first then
   * VSP. Emits one resolved line per tenant slice so checkout creates the
   * correct Sale per tenant.
   */
  async resolveCartLines(
    lines: Array<{ itemId: string; qty: number }>,
  ): Promise<ResolvedStoreCartLine[]> {
    if (lines.length === 0) return [];

    const tenantMap = await this.storeTenantIds();
    const tenantIds = [...tenantMap.values()];

    const itemIds = lines.map((line) => line.itemId);
    const seedItems = await this.prisma.item.findMany({
      where: this.catalogItemWhere(tenantIds, {
        id: { in: itemIds },
      }),
      select: {
        id: true,
        sku: true,
      },
    });
    const seedById = new Map(seedItems.map((item) => [item.id, item]));

    const skus = [
      ...new Set(
        lines
          .map((line) => seedById.get(line.itemId)?.sku.trim())
          .filter((sku): sku is string => Boolean(sku)),
      ),
    ];

    if (skus.length === 0) {
      throw new Error('Cart items are not available in the store');
    }

    const catalogRows = await this.prisma.item.findMany({
      where: this.catalogItemWhere(tenantIds, {
        OR: skus.map((sku) => ({
          sku: { equals: sku, mode: 'insensitive' as const },
        })),
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

    const reservedByTenant = new Map<string, Map<string, number>>();
    for (const tenantId of tenantIds) {
      const tenantSkus = catalogRows
        .filter((r) => r.tenantId === tenantId)
        .map((r) => r.sku);
      reservedByTenant.set(
        tenantId,
        await reservedQtyBySku(this.prisma, tenantId, [...new Set(tenantSkus)]),
      );
    }

    const rowsBySku = new Map<string, typeof catalogRows>();
    for (const row of catalogRows) {
      const key = row.sku.trim().toUpperCase();
      const list = rowsBySku.get(key) ?? [];
      list.push(row);
      rowsBySku.set(key, list);
    }

    const resolved: ResolvedStoreCartLine[] = [];

    for (const line of lines) {
      const seed = seedById.get(line.itemId);
      if (!seed) {
        throw new Error(`Item ${line.itemId} is not available in the store`);
      }
      const qty = Math.max(1, Math.floor(line.qty));
      const skuKey = seed.sku.trim().toUpperCase();
      const matches = [...(rowsBySku.get(skuKey) ?? [])].sort(
        (a, b) =>
          this.tenantPriority(a.tenant.code) - this.tenantPriority(b.tenant.code),
      );
      if (matches.length === 0) {
        throw new Error(`${seed.sku} is not available in the store`);
      }

      const unitPrice = Number(
        matches.find((m) => m.tenant.code === 'VISP')?.sellPrice ??
          matches[0]!.sellPrice,
      );
      const displayName =
        matches.find((m) => m.tenant.code === 'VISP')?.name ?? matches[0]!.name;

      let remaining = qty;
      const slices: ResolvedStoreCartLine[] = [];

      for (const match of matches) {
        if (remaining <= 0) break;
        const available = this.availableForRow(match, reservedByTenant);
        if (available <= 0) continue;
        const take = Math.min(remaining, available);
        slices.push({
          itemId: match.id,
          tenantId: match.tenantId,
          tenantCode: match.tenant.code,
          sku: match.sku,
          name: displayName,
          qty: take,
          unitPrice,
          lineTotal: unitPrice * take,
          availableQuantity: available,
        });
        remaining -= take;
      }

      if (remaining > 0) {
        const totalAvailable = matches.reduce(
          (sum, match) => sum + this.availableForRow(match, reservedByTenant),
          0,
        );
        throw new Error(
          `${displayName} only has ${totalAvailable} available across VISP/VSP`,
        );
      }

      // VISP lines first, then VSP.
      slices.sort(
        (a, b) =>
          this.tenantPriority(a.tenantCode) - this.tenantPriority(b.tenantCode),
      );
      resolved.push(...slices);
    }

    return resolved;
  }
}
