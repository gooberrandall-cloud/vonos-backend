import { Injectable, NotFoundException } from '@nestjs/common';
import type { Item, ItemFilters } from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { resolveListSort } from '../../common/utils/listSort';
import type { PaginatedList } from '../../common/utils/paginatedList';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import {
  HQ6_LIST_WARM_LIMITS,
  hq6WarmSorts,
} from '../../common/utils/hq6ListWarm';
import {
  breakdownFromOnHand,
  reservedQtyBySku,
} from '../../common/utils/availableStock';
import { serializeItem } from '../items/items.mapper';
import { applyLastPurchasePrices } from '../../common/utils/lastPurchasePrices';
import {
  fetchItemFtsIds,
  itemTextSearchWhere,
  relationStringOr,
  shouldUseFtsListSearch,
} from '../../common/utils/listSearch';

/** List columns only — never hydrate full Item + unused relations. */
const CATALOG_LIST_SELECT = {
  id: true,
  tenantId: true,
  sku: true,
  name: true,
  category: true,
  subCategory: true,
  description: true,
  imageUrl: true,
  barcodeType: true,
  unit: true,
  weight: true,
  carModel: true,
  enableImei: true,
  preparationMinutes: true,
  quantity: true,
  binLocation: true,
  locationCode: true,
  reorderPoint: true,
  costPrice: true,
  sellPrice: true,
  currency: true,
  status: true,
  availableForRetail: true,
  brandId: true,
  createdByUserId: true,
  createdByName: true,
  createdAt: true,
  updatedAt: true,
  brand: { select: { name: true } },
  locationStock: {
    select: {
      locationCode: true,
      binLocation: true,
      quantity: true,
    },
  },
} as const;

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Each operating tenant (VA / VP / VW / VISP / VSP) lists products in its
   * own catalog scope — not a shared VW retail view.
   */
  private catalogScope(requestTenantId: string): {
    tenantIds: string[];
    sharedRetailOnly: boolean;
  } {
    return { tenantIds: [requestTenantId], sharedRetailOnly: false };
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
      const locSum = (row.locationStock ?? []).reduce(
        (sum, loc) => sum + loc.quantity,
        0,
      );
      const onHand = Math.max(row.quantity, locSum);
      const { available } = breakdownFromOnHand(onHand, reserved);
      return { ...row, quantity: onHand, availableQuantity: available };
    });
  }

  private async catalogBaseWhere(
    tenantIds: string[],
    filters: ItemFilters,
    sharedRetailOnly: boolean,
  ) {
    let searchWhere:
      | { id: { in: string[] } }
      | ReturnType<typeof itemTextSearchWhere>
      | undefined;
    if (filters.search && shouldUseFtsListSearch(filters.search)) {
      const ftsIds = await fetchItemFtsIds(
        this.prisma,
        { in: tenantIds },
        filters.search,
      );
      searchWhere =
        ftsIds.length > 0
          ? { id: { in: ftsIds } }
          : itemTextSearchWhere(filters.search, {
              extraFuzzyFields: (_token, contains) => [
                { category: contains },
                relationStringOr('brand', 'name', contains),
              ],
            });
    } else if (filters.search) {
      searchWhere = itemTextSearchWhere(filters.search, {
        // category has btree; skip description (no trigram → seq scan).
        extraFuzzyFields: (_token, contains) => [
          { category: contains },
          relationStringOr('brand', 'name', contains),
        ],
      });
    }
    const locationWhere = filters.locationCode
      ? {
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
        }
      : undefined;
    const andClauses = [locationWhere, searchWhere].filter(
      (clause): clause is NonNullable<typeof clause> => clause != null,
    );

    return {
      tenantId: { in: tenantIds },
      deletedAt: null,
      ...(sharedRetailOnly ? { availableForRetail: true } : {}),
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
      ...(filters.availableForRetail !== undefined && !sharedRetailOnly
        ? { availableForRetail: filters.availableForRetail }
        : {}),
      ...(andClauses.length > 0 ? { AND: andClauses } : {}),
    };
  }

  async list(filters: ItemFilters): Promise<PaginatedList<Item>> {
    const requestTenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      status: filters.status,
      category: filters.category,
      locationCode: filters.locationCode,
      unit: filters.unit,
      brandName: filters.brandName,
      availableForRetail:
        filters.availableForRetail === undefined
          ? ''
          : filters.availableForRetail
            ? 1
            : 0,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
      sum: filters.includeSummary === false ? 0 : 1,
    });

    return withListPageCache(
      this.cache,
      requestTenantId,
      'catalog:v9',
      filterKey,
      () => this.listUncached(filters, requestTenantId),
    );
  }

  private async listUncached(
    filters: ItemFilters,
    requestTenantId: string,
  ): Promise<PaginatedList<Item>> {
    const { tenantIds, sharedRetailOnly } =
      this.catalogScope(requestTenantId);
    const limit = filters.limit ?? 10;
    const includeSummary = filters.includeSummary !== false;

    const sort = resolveListSort(
      filters.sortBy,
      filters.sortDir,
      {
        name: { field: 'name', type: 'string' },
        sku: { field: 'sku', type: 'string' },
        quantity: { field: 'quantity', type: 'number' },
        costPrice: { field: 'costPrice', type: 'number' },
        sellPrice: { field: 'sellPrice', type: 'number' },
        sellingPrice: { field: 'sellPrice', type: 'number' },
        createdAt: { field: 'createdAt', type: 'date' },
        updatedAt: { field: 'updatedAt', type: 'date' },
        category: { field: 'category', type: 'string' },
        status: { field: 'status', type: 'string' },
      },
      {
        sortField: 'updatedAt',
        sortDir: 'desc',
        sortValueType: 'date',
      },
    );

    const pagination = buildCompositeCursorQuery({
      sortField: sort.sortField,
      sortDir: sort.sortDir,
      cursor: filters.cursor,
      limit,
      sortValueType: sort.sortValueType,
    });
    const baseWhere = await this.catalogBaseWhere(
      tenantIds,
      filters,
      sharedRetailOnly,
    );

    // Summary-only (limit=1 from deferred count) — skip heavy row mapping.
    if (includeSummary && limit <= 1 && !filters.cursor) {
      const totalCount = await this.prisma.item.count({ where: baseWhere });
      return { items: [], totalCount };
    }

    const [rows, totalCount] = await Promise.all([
      this.prisma.item.findMany({
        where: {
          ...baseWhere,
          ...(pagination.where ?? {}),
        },
        select: CATALOG_LIST_SELECT,
        orderBy: [
          { [sort.sortField]: sort.sortDir },
          { id: sort.sortDir },
        ],
        take: pagination.take,
      }),
      includeSummary
        ? this.prisma.item.count({ where: baseWhere })
        : Promise.resolve(undefined as number | undefined),
    ]);

    const items = await applyLastPurchasePrices(
      this.prisma,
      requestTenantId,
      rows.map(serializeItem),
    );
    // List UIs use on-hand `quantity` (HQ6 Current Stock). Skip the
    // Approved-requisition JSONB scan — it dominated page-flip latency.
    // Detail/getById still computes availableQuantity.

    if (!includeSummary || totalCount == null) {
      return { items };
    }

    return { items, totalCount };
  }

  async getById(id: string): Promise<Item> {
    const requestTenantId = this.tenantDb.requireTenantId();
    const { tenantIds, sharedRetailOnly } =
      this.catalogScope(requestTenantId);

    const row = await this.prisma.item.findFirst({
      where: {
        id,
        tenantId: { in: tenantIds },
        deletedAt: null,
        ...(sharedRetailOnly ? { availableForRetail: true } : {}),
      },
    });
    if (row) {
      const [withAvailable] = await this.withAvailableQuantity([
        serializeItem(row),
      ]);
      return withAvailable!;
    }

    throw new NotFoundException('Catalog item not found');
  }
}

/** Boot/cron: seed HQ6 products list (catalog resource, name/asc, limit 25). */
export async function warmDefaultCatalogListPages(
  prisma: import('@prisma/client').PrismaClient,
  cache: CacheService,
  tenantId: string,
): Promise<void> {

  for (const limit of HQ6_LIST_WARM_LIMITS) {
    for (const sort of hq6WarmSorts({ sortBy: 'updatedAt', sortDir: 'desc' })) {
      for (const includeSummary of [false, true] as const) {
        const filterKey = listPageFilterKey({
          search: undefined,
          status: undefined,
          category: undefined,
          locationCode: undefined,
          unit: undefined,
          brandName: undefined,
          availableForRetail: '',
          cursor: undefined,
          limit,
          sortBy: sort.sortBy,
          sortDir: sort.sortDir,
          sum: includeSummary ? 1 : 0,
        });
        await withListPageCache(
          cache,
          tenantId,
          'catalog:v9',
          filterKey,
          async () => {
            const baseWhere = {
              tenantId,
              deletedAt: null as null,
            };
            const [rows, totalCount] = await Promise.all([
              prisma.item.findMany({
                where: baseWhere,
                select: CATALOG_LIST_SELECT,
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                take: limit,
              }),
              includeSummary
                ? prisma.item.count({ where: baseWhere })
                : Promise.resolve(undefined as number | undefined),
            ]);
            const items = await applyLastPurchasePrices(
              prisma,
              tenantId,
              rows.map(serializeItem),
            );
            if (!includeSummary || totalCount == null) {
              return { items };
            }
            return { items, totalCount };
          },
          600,
        );
      }
    }
  }
}
