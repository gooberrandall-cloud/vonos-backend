import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CsvImportResult,
  Item,
  ItemFilters,
  ItemLocationStockInput,
  KpiSummary,
  PeerStockBySkuResult,
  StockAvailabilityResult,
  StockStatus,
} from '@vonos/types';
import {
  AUTOS_GROUP_CODES,
  isAutosGroupCode,
  isGroupStockConsumerTenant,
  isProductStockLocationCode,
  PRODUCT_STOCK_LOCATION_CODES,
} from '@vonos/types';
import { Prisma } from '@prisma/client';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache, invalidateTenantListCache } from '../../common/cache/cacheInvalidation';
import { AuditService } from '../audit/audit.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import { resolveListSort } from '../../common/utils/listSort';
import { parseCsv, pickCsvField } from '../../common/utils/csvImport';
import {
  businessLocationsFromConfig,
  resolveBusinessLocationCode,
  productStockBusinessLocations,
} from '../../common/utils/businessLocation';
import {
  isHq6ProductCsv,
  parseProductCsvRow,
} from '../../common/utils/productCsvImport';
import { parseOpeningStockCsvRow } from '../../common/utils/openingStockCsvImport';
import { excludeOpeningStockPurchasesWhere } from '../../common/utils/openingStockMovement';
import { adjustItemLocationStock } from '../../common/utils/itemLocationStock';
import { toNumber } from '../../common/utils/serializers';
import { applyLastPurchasePrices } from '../../common/utils/lastPurchasePrices';
import {
  fetchItemFtsIds,
  itemTextSearchWhere,
  relationStringOr,
  shouldUseFtsListSearch,
} from '../../common/utils/listSearch';
import { serializeItem } from './items.mapper';
import {
  breakdownFromOnHand,
  computeAvailableStock,
  reservedQtyBySku,
} from '../../common/utils/availableStock';

const ITEM_DETAIL_INCLUDE = {
  locationStock: true,
  brand: { select: { name: true } },
} as const;

/** Brand join for update — skip a separate brand lookup when the name is unchanged. */
const ITEM_BRAND_INCLUDE = {
  brand: { select: { id: true, name: true } },
} as const;

/** Process-local map — avoid re-resolving tenant codes on hot list paths. */
const tenantCodeById = new Map<string, string>();

interface CreateItemDto {
  sku: string;
  name: string;
  category?: string;
  subCategory?: string;
  description?: string;
  imageUrl?: string;
  barcodeType?: string;
  unit?: string;
  weight?: string;
  carModel?: string;
  enableImei?: boolean;
  preparationMinutes?: number;
  quantity?: number;
  binLocation?: string;
  locationCode?: string;
  reorderPoint?: number;
  costPrice: number;
  sellPrice?: number | null;
  currency?: string;
  status?: StockStatus;
  availableForRetail?: boolean;
  brandId?: string;
  brandName?: string;
  locationStock?: ItemLocationStockInput[];
}

type UpdateItemDto = Partial<CreateItemDto>;

interface NormalizedLocationRow {
  locationCode: string;
  binLocation: string;
  quantity: number;
}

/** Derive stock status from quantity + reorder point unless explicitly provided. */
function deriveStatus(
  quantity: number,
  reorderPoint: number | null | undefined,
  explicit?: StockStatus,
): StockStatus {
  if (explicit) return explicit;
  if (quantity <= 0) return 'out_of_stock';
  if (reorderPoint != null && quantity <= reorderPoint) return 'low_stock';
  return 'in_stock';
}

/**
 * Merge per-location input into unique (locationCode + binLocation) rows,
 * summing quantities and validating each location against tenant config.
 */
function normalizeLocationRows(
  input: ItemLocationStockInput[],
  validate: (locationCode?: string | null) => string | null,
): NormalizedLocationRow[] {
  const merged = new Map<string, NormalizedLocationRow>();
  for (const raw of input) {
    const locationCode = validate(raw.locationCode);
    if (!locationCode) continue;
    const binLocation = raw.binLocation?.trim() || '';
    const quantity = Number.isFinite(raw.quantity) ? Math.trunc(raw.quantity) : 0;
    const key = `${locationCode}::${binLocation}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += quantity;
    } else {
      merged.set(key, { locationCode, binLocation, quantity });
    }
  }
  return Array.from(merged.values());
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cache: CacheService,
  ) {}

  private invalidateItemCaches(
    extraTenantIds: string[] = [],
    opts: { stockChanged?: boolean } = {},
  ): void {
    const tenantId = this.tenantDb.requireTenantId();
    // Metadata edits (name/price/tax) must not cold-miss overview/reports.
    // Stock qty changes still need dashboard KPI refresh.
    if (opts.stockChanged) {
      void invalidateTenantDashboardCache(this.cache, tenantId);
      for (const id of extraTenantIds) {
        if (id && id !== tenantId) {
          void invalidateTenantDashboardCache(this.cache, id);
        }
      }
      return;
    }
    void invalidateTenantListCache(this.cache, tenantId, [
      'items',
      'catalog:v9',
      'catalog:v8',
    ]);
    for (const id of extraTenantIds) {
      if (id && id !== tenantId) {
        void invalidateTenantListCache(this.cache, id, [
          'items',
          'catalog:v9',
          'catalog:v8',
        ]);
      }
    }
  }

  /**
   * Each operating tenant owns its catalog. Read/update only the caller's
   * items — never write VISP/VSP marketplace prices onto VW warehouse rows.
   */
  private async cachedTenantCode(tenantId: string): Promise<string | null> {
    const hit = tenantCodeById.get(tenantId);
    if (hit) return hit;
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { code: true },
    });
    if (!row?.code) return null;
    tenantCodeById.set(tenantId, row.code);
    return row.code;
  }

  private async findItemForRequest(
    id: string,
    opts: { detail?: boolean; brand?: boolean } = {},
  ) {
    const requestTenantId = this.tenantDb.requireTenantId();
    const include = opts.detail
      ? ITEM_DETAIL_INCLUDE
      : opts.brand
        ? ITEM_BRAND_INCLUDE
        : undefined;

    const row = await this.prisma.item.findFirst({
      where: { id, tenantId: requestTenantId, deletedAt: null },
      ...(include ? { include } : {}),
    });
    if (!row) {
      throw new NotFoundException('Item not found');
    }

    return { row, homeTenantId: requestTenantId };
  }

  async list(
    filters: ItemFilters & { availableForRetail?: boolean },
  ): Promise<Item[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      status: filters.status,
      category: filters.category,
      unit: filters.unit,
      brandName: filters.brandName,
      availableForRetail:
        filters.availableForRetail === undefined
          ? undefined
          : filters.availableForRetail
            ? 1
            : 0,
      locationCode: filters.locationCode,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
      sum: filters.includeSummary === false ? 0 : 1,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'items',
      filterKey,
      () => this.listUncached(filters, tenantId),
    );
  }

  private async listUncached(
    filters: ItemFilters & { availableForRetail?: boolean },
    tenantId: string,
  ): Promise<Item[]> {
    const db = this.tenantDb.db;
    const limit = filters.limit ?? 10;

    const sort = resolveListSort(filters.sortBy, filters.sortDir, {
      name: { field: 'name', type: 'string' },
      sku: { field: 'sku', type: 'string' },
      quantity: { field: 'quantity', type: 'number' },
      costPrice: { field: 'costPrice', type: 'number' },
      sellPrice: { field: 'sellPrice', type: 'number' },
      // Alias used by some list UIs / older clients
      sellingPrice: { field: 'sellPrice', type: 'number' },
      createdAt: { field: 'createdAt', type: 'date' },
      updatedAt: { field: 'updatedAt', type: 'date' },
      category: { field: 'category', type: 'string' },
      status: { field: 'status', type: 'string' },
    }, {
      sortField: 'updatedAt',
      sortDir: 'desc',
      sortValueType: 'date',
    });

    const pagination = buildCompositeCursorQuery({
      sortField: sort.sortField,
      sortDir: sort.sortDir,
      cursor: filters.cursor,
      limit,
      sortValueType: sort.sortValueType,
    });

    let searchWhere:
      | { id: { in: string[] } }
      | ReturnType<typeof itemTextSearchWhere>
      | undefined;
    if (filters.search && shouldUseFtsListSearch(filters.search)) {
      const ftsIds = await fetchItemFtsIds(db, tenantId, filters.search);
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
    const andClauses = [searchWhere, locationWhere].filter(
      (clause): clause is NonNullable<typeof clause> => clause != null,
    );

    const rows = await db.item.findMany({
      where: {
        tenantId,
        deletedAt: null,
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
        ...(andClauses.length > 0 ? { AND: andClauses } : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ [sort.sortField]: sort.sortDir }, { id: sort.sortDir }],
      // List projection — never pull full Item + all locationStock columns.
      select: {
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
      },
      take: pagination.take,
    });

    return applyLastPurchasePrices(
      this.tenantDb.db,
      tenantId,
      rows.map(serializeItem),
    );
  }

  async getById(id: string): Promise<Item> {
    const { row } = await this.findItemForRequest(id, { detail: true });
    return serializeItem(row);
  }

  async getMeta(
    id: string,
  ): Promise<{ id: string; name: string; sku: string }> {
    const { row } = await this.findItemForRequest(id);
    return { id: row.id, name: row.name, sku: row.sku };
  }

  /** HQ6 product stock history — movements that include this item. */
  async stockHistory(id: string): Promise<
    Array<{
      id: string;
      date: string;
      reference: string;
      type: string;
      status: string;
      quantity: number;
      quantityChange: number;
      newQuantity: number;
      unitCost: number | null;
      customerSupplierInfo: string | null;
      createdByName: string | null;
    }>
  > {
    const { row: item, homeTenantId } = await this.findItemForRequest(id);
    const tenantId = homeTenantId;
    const db = this.prisma.forTenant(homeTenantId);

    const movements = await db.stockMovement.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      select: {
        id: true,
        date: true,
        reference: true,
        type: true,
        status: true,
        lines: true,
        notes: true,
        createdByName: true,
        supplier: { select: { name: true } },
      },
    });

    const history: Array<{
      id: string;
      date: string;
      reference: string;
      type: string;
      status: string;
      quantity: number;
      quantityChange: number;
      newQuantity: number;
      unitCost: number | null;
      customerSupplierInfo: string | null;
      createdByName: string | null;
    }> = [];

    let runningQty = item.quantity;

    for (const movement of movements) {
      const lines = Array.isArray(movement.lines)
        ? (movement.lines as Array<{
            itemId?: string;
            sku?: string;
            name?: string;
            quantity?: number;
            unitCost?: number;
          }>)
        : [];
      for (const line of lines) {
        if (line.itemId !== item.id && line.sku !== item.sku) continue;
        const qty = Number(line.quantity ?? 0);
        const isInbound = movement.type === 'inbound';
        const change = isInbound ? qty : -qty;
        const newQty = runningQty;
        runningQty -= change;

        const isOpening = movement.reference.startsWith('OS/');
        const infoParts = [
          isOpening ? 'Opening stock' : null,
          movement.supplier?.name ?? null,
          movement.notes?.trim() || null,
          movement.createdByName ? `by ${movement.createdByName}` : null,
        ].filter(Boolean);

        history.push({
          id: movement.id,
          date: movement.date.toISOString(),
          reference: movement.reference,
          type: isOpening ? 'opening_stock' : movement.type,
          status: movement.status,
          quantity: qty,
          quantityChange: change,
          newQuantity: newQty,
          unitCost:
            line.unitCost != null ? toNumber(line.unitCost) : null,
          customerSupplierInfo:
            infoParts.length > 0 ? infoParts.join(' · ') : null,
          createdByName: movement.createdByName ?? null,
        });
      }
      if (history.length >= 100) break;
    }

    return history;
  }

  /** Former opening-stock rows for the add/edit opening stock table. */
  async listOpeningStock(id: string): Promise<
    Array<{
      id: string;
      quantity: number;
      unitCost: number | null;
      date: string;
      note: string | null;
      createdByName: string | null;
      createdAt: string;
      locationCode: string | null;
    }>
  > {
    const { row: item, homeTenantId } = await this.findItemForRequest(id);
    const tenantId = homeTenantId;
    const db = this.prisma.forTenant(homeTenantId);

    const movements = await db.stockMovement.findMany({
      where: {
        tenantId,
        deletedAt: null,
        type: 'inbound',
        reference: { startsWith: 'OS/' },
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      take: 200,
      select: {
        id: true,
        date: true,
        createdAt: true,
        lines: true,
        notes: true,
        createdByName: true,
        locationCode: true,
      },
    });

    const rows: Array<{
      id: string;
      quantity: number;
      unitCost: number | null;
      date: string;
      note: string | null;
      createdByName: string | null;
      createdAt: string;
      locationCode: string | null;
    }> = [];

    for (const movement of movements) {
      const lines = Array.isArray(movement.lines)
        ? (movement.lines as Array<{
            itemId?: string;
            sku?: string;
            quantity?: number;
            unitCost?: number;
          }>)
        : [];
      for (const line of lines) {
        if (line.itemId !== item.id && line.sku !== item.sku) continue;
        const y = movement.date.getFullYear();
        const m = String(movement.date.getMonth() + 1).padStart(2, '0');
        const d = String(movement.date.getDate()).padStart(2, '0');
        rows.push({
          id: movement.id,
          quantity: Number(line.quantity ?? 0),
          unitCost:
            line.unitCost != null ? toNumber(line.unitCost) : null,
          date: `${y}-${m}-${d}`,
          note: movement.notes ?? null,
          createdByName: movement.createdByName ?? null,
          createdAt: movement.createdAt.toISOString(),
          locationCode: movement.locationCode ?? null,
        });
      }
    }

    return rows;
  }

  /**
   * Save opening-stock table rows: keep dated records, set on-hand qty to the
   * sum of rows, and stamp who/when on each StockMovement (OS/…).
   */
  async saveOpeningStock(
    id: string,
    body: {
      locationCode: string;
      costPrice?: number;
      rows: Array<{
        id?: string;
        quantity: number;
        unitCost: number;
        date: string;
        note?: string;
      }>;
    },
  ): Promise<Item> {
    const requestTenantId = this.tenantDb.requireTenantId();
    const { row: existing, homeTenantId } = await this.findItemForRequest(id, {
      brand: true,
    });
    const tenantId = homeTenantId;
    const db = this.prisma.forTenant(homeTenantId);

    const validate = await this.tenantDb.businessLocationValidator();
    const locationCode = validate(body.locationCode);
    if (!locationCode) {
      throw new BadRequestException('Business location is required');
    }

    const incoming = (body.rows ?? []).map((row) => ({
      id: row.id?.trim() || undefined,
      quantity: Number.isFinite(row.quantity) ? Math.trunc(row.quantity) : 0,
      unitCost: Number.isFinite(row.unitCost) ? row.unitCost : 0,
      date: row.date?.trim() || new Date().toISOString().slice(0, 10),
      note: row.note?.trim() || null,
    }));

    if (incoming.length === 0) {
      throw new BadRequestException('Add at least one opening stock row');
    }

    const existingOs = await this.listOpeningStock(id);
    const keepIds = new Set(
      incoming.map((r) => r.id).filter((v): v is string => Boolean(v)),
    );
    const toRemove = existingOs.filter((r) => !keepIds.has(r.id));

    const createdBy = await this.auditService.createdByFields();
    const nextQty = incoming.reduce((sum, r) => sum + r.quantity, 0);
    const lastCost =
      body.costPrice != null && Number.isFinite(body.costPrice)
        ? body.costPrice
        : (incoming[incoming.length - 1]?.unitCost ??
          toNumber(existing.costPrice));
    const homeCode = await this.cachedTenantCode(tenantId);
    const catalogOnly = isGroupStockConsumerTenant(homeCode ?? undefined);

    await db.$transaction(async (tx) => {
      if (toRemove.length > 0) {
        await tx.stockMovement.updateMany({
          where: {
            tenantId,
            id: { in: toRemove.map((r) => r.id) },
            deletedAt: null,
          },
          data: { deletedAt: new Date() },
        });
      }

      for (const row of incoming) {
        const line = [
          {
            itemId: existing.id,
            sku: existing.sku,
            name: existing.name,
            quantity: row.quantity,
            unitCost: row.unitCost,
          },
        ];
        const grandTotal = row.quantity * row.unitCost;
        const date = new Date(`${row.date}T12:00:00.000Z`);
        const notes = row.note || 'Opening stock';

        if (row.id) {
          const owned = existingOs.some((r) => r.id === row.id);
          if (!owned) {
            throw new BadRequestException('Unknown opening stock row');
          }
          // Prior OS rows are append-only history — do not mutate qty/cost/date.
          continue;
        } else {
          await tx.stockMovement.create({
            data: {
              tenantId,
              type: 'inbound',
              reference: `OS/${existing.sku}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              status: 'Received',
              lines: line as unknown as Prisma.InputJsonValue,
              itemCount: 1,
              grandTotal,
              notes,
              locationCode,
              date,
              // Stock history only — never a supplier bill (Purchases list excludes OS/).
              paymentStatus: null,
              ...createdBy,
            },
          });
        }
      }

      const existingLoc = await tx.itemLocationStock.findFirst({
        where: { itemId: existing.id, locationCode },
      });
      if (existingLoc) {
        await tx.itemLocationStock.update({
          where: { id: existingLoc.id },
          data: { quantity: nextQty },
        });
      } else {
        await tx.itemLocationStock.create({
          data: {
            tenantId,
            itemId: existing.id,
            locationCode,
            binLocation: existing.binLocation ?? '',
            quantity: nextQty,
          },
        });
      }

      const otherSum = await tx.itemLocationStock.aggregate({
        where: {
          itemId: existing.id,
          NOT: { locationCode },
        },
        _sum: { quantity: true },
      });
      const headerQty = nextQty + (otherSum._sum.quantity ?? 0);
      const nextStatus = catalogOnly
        ? existing.status === 'out_of_stock'
          ? 'in_stock'
          : existing.status
        : deriveStatus(headerQty, existing.reorderPoint);

      await tx.item.update({
        where: { id: existing.id },
        data: {
          quantity: headerQty,
          locationCode,
          costPrice: lastCost,
          status: nextStatus,
        },
      });
    });

    void this.auditService.log({
      action: 'updated',
      entityType: 'item',
      entityId: id,
      summary: `Opening stock set to ${nextQty} for ${existing.sku}`,
      metadata: {
        locationCode,
        rowCount: incoming.length,
        quantity: nextQty,
        unitCost: lastCost,
      },
    });
    void this.invalidateItemCaches(
      homeTenantId !== requestTenantId ? [homeTenantId] : [],
      { stockChanged: true },
    );

    const { row } = await this.findItemForRequest(id, { detail: true });
    return serializeItem(row);
  }

  async kpiSummary(): Promise<KpiSummary> {
    const tenantId = this.tenantDb.requireTenantId();
    const cacheKey = `kpi-summary:${tenantId}`;
    const cached = await this.cache.get<KpiSummary>(cacheKey);
    if (cached) return cached;

    const db = this.tenantDb.db;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const itemWhere = { tenantId, deletedAt: null };

    const [totalSku, stockValueRows, currencyRow, todayInbound, todayOutbound] =
      await Promise.all([
        db.item.count({ where: itemWhere }),
        db.$queryRaw<[{ stock_value: Prisma.Decimal | null }]>`
        SELECT COALESCE(SUM(quantity * "costPrice"), 0) AS stock_value
        FROM "Item"
        WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
      `,
        db.item.findFirst({
          where: itemWhere,
          select: { currency: true },
          orderBy: { id: 'asc' },
        }),
        db.stockMovement.count({
          where: {
            tenantId,
            deletedAt: null,
            type: 'inbound',
            ...excludeOpeningStockPurchasesWhere(),
            date: { gte: startOfDay, lte: endOfDay },
          },
        }),
        db.stockMovement.count({
          where: {
            tenantId,
            deletedAt: null,
            type: 'outbound',
            date: { gte: startOfDay, lte: endOfDay },
          },
        }),
      ]);

    const currency = currencyRow?.currency ?? 'NGN';
    const stockValue = toNumber(stockValueRows[0]?.stock_value ?? 0);

    const result: KpiSummary = {
      totalSku,
      todayInbound,
      todayOutbound,
      stockValue,
      currency,
    };
    await this.cache.set(cacheKey, result, 30);
    return result;
  }

  async create(dto: CreateItemDto): Promise<Item> {
    const tenantId = this.tenantDb.requireTenantId();
    // One wave: actor + tenant config (validator shares the memoized tenant load).
    const [createdBy, validate, tenantRow] = await Promise.all([
      this.auditService.createdByFields(),
      this.tenantDb.businessLocationValidator(),
      this.tenantDb.getTenantCodeAndConfig(),
    ]);

    const locationRows =
      dto.locationStock && dto.locationStock.length > 0
        ? normalizeLocationRows(dto.locationStock, validate)
        : [];

    // Primary location/quantity: derived from per-location rows when present,
    // otherwise from the flat fields. Own-scope catalogs default to this
    // tenant's product home (VSP→VSP) so marketplace rows are not labeled VW.
    const homeLocations = productStockBusinessLocations({
      ...(tenantRow?.config ?? {}),
      code: tenantRow?.code ?? undefined,
    });
    const defaultHomeCode = homeLocations[0]?.code ?? null;

    const primaryLocation =
      locationRows[0]?.locationCode ??
      (dto.locationCode?.trim()
        ? validate(dto.locationCode)
        : defaultHomeCode);
    const primaryBin =
      locationRows[0]?.binLocation || (dto.binLocation ?? null) || null;
    const quantity =
      locationRows.length > 0
        ? locationRows.reduce((sum, r) => sum + r.quantity, 0)
        : (dto.quantity ?? 0);

    const catalogOnly = isGroupStockConsumerTenant(tenantRow?.code);
    // VA/VP price catalog: qty 0 must stay Active — not "out of stock".
    const status = catalogOnly
      ? (dto.status ?? 'in_stock')
      : deriveStatus(quantity, dto.reorderPoint, dto.status);

    let brandId = dto.brandId?.trim() || null;
    if (!brandId && dto.brandName?.trim()) {
      const existingBrand = await this.tenantDb.db.brand.findFirst({
        where: {
          tenantId,
          deletedAt: null,
          name: { equals: dto.brandName.trim(), mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (existingBrand) {
        brandId = existingBrand.id;
      } else {
        const created = await this.tenantDb.db.brand.create({
          data: { tenantId, name: dto.brandName.trim() },
          select: { id: true },
        });
        brandId = created.id;
      }
    }

    const row = await this.tenantDb.db.item.create({
      data: {
        tenantId,
        sku: dto.sku,
        name: dto.name,
        category: dto.category ?? null,
        subCategory: dto.subCategory?.trim() || null,
        description: dto.description?.trim() || null,
        imageUrl: dto.imageUrl?.trim() || null,
        barcodeType: dto.barcodeType?.trim() || null,
        unit: dto.unit?.trim() || null,
        weight: dto.weight?.trim() || null,
        carModel: dto.carModel?.trim() || null,
        enableImei: dto.enableImei ?? false,
        preparationMinutes:
          dto.preparationMinutes != null && Number.isFinite(dto.preparationMinutes)
            ? Math.trunc(dto.preparationMinutes)
            : null,
        quantity,
        binLocation: primaryBin,
        locationCode: primaryLocation,
        reorderPoint: dto.reorderPoint ?? null,
        costPrice: dto.costPrice,
        sellPrice: dto.sellPrice ?? null,
        currency: dto.currency ?? 'NGN',
        status,
        availableForRetail: dto.availableForRetail ?? false,
        brandId,
        ...createdBy,
        ...(locationRows.length > 0
          ? {
              locationStock: {
                create: locationRows.map((r) => ({
                  tenantId,
                  locationCode: r.locationCode,
                  binLocation: r.binLocation,
                  quantity: r.quantity,
                })),
              },
            }
          : {}),
      },
      include: ITEM_DETAIL_INCLUDE,
    });
    void this.auditService.log({
      action: 'created',
      entityType: 'item',
      entityId: row.id,
      summary: `Created item ${row.sku}`,
    });
    void this.invalidateItemCaches([], {
      stockChanged: quantity !== 0 || locationRows.length > 0,
    });
    return serializeItem(row);
  }

  async update(
    id: string,
    dto: UpdateItemDto & {
      openingStock?: {
        locationCode: string;
        costPrice?: number;
        rows: Array<{
          id?: string;
          quantity: number;
          unitCost: number;
          date: string;
          note?: string;
        }>;
      };
    },
  ): Promise<Item> {
    if (dto.openingStock) {
      return this.saveOpeningStock(id, dto.openingStock);
    }

    const requestTenantId = this.tenantDb.requireTenantId();
    const { row: existing, homeTenantId } = await this.findItemForRequest(id, {
      brand: true,
    });
    const tenantId = homeTenantId;
    const db = this.prisma.forTenant(homeTenantId);

    const needsLocationValidation =
      dto.locationCode !== undefined || dto.locationStock !== undefined;

    const validate = needsLocationValidation
      ? await this.tenantDb.businessLocationValidator()
      : (_code?: string | null) => null;

    const resolvedLocation =
      dto.locationCode !== undefined ? validate(dto.locationCode) : undefined;

    // When per-location rows are supplied, they become the source of truth:
    // replace the rows and recompute quantity + primary location/bin + status.
    const locationRows =
      dto.locationStock !== undefined
        ? normalizeLocationRows(dto.locationStock, validate)
        : undefined;

    const nextReorderPoint =
      dto.reorderPoint !== undefined ? dto.reorderPoint : existing.reorderPoint;

    let derivedQuantity: number | undefined;
    let derivedPrimaryLocation: string | null | undefined;
    let derivedPrimaryBin: string | null | undefined;
    if (locationRows !== undefined) {
      derivedQuantity = locationRows.reduce((sum, r) => sum + r.quantity, 0);
      derivedPrimaryLocation =
        locationRows[0]?.locationCode ?? resolvedLocation ?? null;
      derivedPrimaryBin = locationRows[0]?.binLocation || null;
    }

    const nextQuantity =
      derivedQuantity !== undefined
        ? derivedQuantity
        : dto.quantity !== undefined
          ? dto.quantity
          : existing.quantity;

    const stockFieldsChanged =
      dto.quantity !== undefined ||
      dto.reorderPoint !== undefined ||
      locationRows !== undefined;

    let nextStatus: StockStatus | undefined;
    if (dto.status !== undefined) {
      nextStatus = dto.status;
    } else if (stockFieldsChanged) {
      const homeCode = await this.cachedTenantCode(tenantId);
      const catalogOnly = isGroupStockConsumerTenant(homeCode);
      nextStatus = catalogOnly
        ? existing.status === 'out_of_stock'
          ? 'in_stock'
          : undefined
        : deriveStatus(nextQuantity, nextReorderPoint);
    } else {
      // Typical product edit (name/price/tax) — no status recompute, no tenant hit.
      nextStatus = undefined;
    }

    let nextBrandId: string | null | undefined;
    if (dto.brandId !== undefined) {
      nextBrandId = dto.brandId?.trim() || null;
    } else if (dto.brandName !== undefined) {
      const name = dto.brandName.trim();
      if (!name) {
        nextBrandId = null;
      } else {
        const currentBrand = (
          existing as { brand?: { id: string; name: string } | null }
        ).brand;
        if (
          currentBrand &&
          currentBrand.name.localeCompare(name, undefined, {
            sensitivity: 'accent',
          }) === 0
        ) {
          // Unchanged brand — skip findFirst / create.
          nextBrandId = currentBrand.id;
        } else {
          const existingBrand = await db.brand.findFirst({
            where: {
              tenantId,
              deletedAt: null,
              name: { equals: name, mode: 'insensitive' },
            },
            select: { id: true },
          });
          if (existingBrand) {
            nextBrandId = existingBrand.id;
          } else {
            const created = await db.brand.create({
              data: { tenantId, name },
              select: { id: true },
            });
            nextBrandId = created.id;
          }
        }
      }
    }

    const itemData = {
      ...(dto.sku !== undefined ? { sku: dto.sku } : {}),
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.category !== undefined ? { category: dto.category } : {}),
      ...(derivedQuantity !== undefined
        ? { quantity: derivedQuantity }
        : dto.quantity !== undefined
          ? { quantity: dto.quantity }
          : {}),
      ...(derivedPrimaryBin !== undefined
        ? { binLocation: derivedPrimaryBin }
        : dto.binLocation !== undefined
          ? { binLocation: dto.binLocation }
          : {}),
      ...(derivedPrimaryLocation !== undefined
        ? { locationCode: derivedPrimaryLocation }
        : resolvedLocation !== undefined
          ? { locationCode: resolvedLocation }
          : {}),
      ...(dto.reorderPoint !== undefined
        ? { reorderPoint: dto.reorderPoint }
        : {}),
      ...(dto.costPrice !== undefined ? { costPrice: dto.costPrice } : {}),
      ...(dto.sellPrice !== undefined ? { sellPrice: dto.sellPrice } : {}),
      ...(dto.subCategory !== undefined
        ? { subCategory: dto.subCategory?.trim() || null }
        : {}),
      ...(dto.description !== undefined
        ? { description: dto.description?.trim() || null }
        : {}),
      ...(dto.imageUrl !== undefined
        ? { imageUrl: dto.imageUrl?.trim() || null }
        : {}),
      ...(dto.barcodeType !== undefined
        ? { barcodeType: dto.barcodeType?.trim() || null }
        : {}),
      ...(dto.unit !== undefined ? { unit: dto.unit?.trim() || null } : {}),
      ...(dto.weight !== undefined
        ? { weight: dto.weight?.trim() || null }
        : {}),
      ...(dto.carModel !== undefined
        ? { carModel: dto.carModel?.trim() || null }
        : {}),
      ...(dto.enableImei !== undefined ? { enableImei: dto.enableImei } : {}),
      ...(dto.preparationMinutes !== undefined
        ? {
            preparationMinutes:
              dto.preparationMinutes != null &&
              Number.isFinite(dto.preparationMinutes)
                ? Math.trunc(dto.preparationMinutes)
                : null,
          }
        : {}),
      ...(nextBrandId !== undefined ? { brandId: nextBrandId } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...(nextStatus !== undefined ? { status: nextStatus } : {}),
      ...(dto.availableForRetail !== undefined
        ? { availableForRetail: dto.availableForRetail }
        : {}),
    };

    const row =
      locationRows !== undefined
        ? await db.$transaction(async (tx) => {
            await tx.itemLocationStock.deleteMany({
              where: { itemId: id, tenantId },
            });
            if (locationRows.length > 0) {
              await tx.itemLocationStock.createMany({
                data: locationRows.map((r) => ({
                  tenantId,
                  itemId: id,
                  locationCode: r.locationCode,
                  binLocation: r.binLocation,
                  quantity: r.quantity,
                })),
              });
            }
            return tx.item.update({
              where: { id },
              data: itemData,
              include: ITEM_DETAIL_INCLUDE,
            });
          })
        : await db.item.update({
            where: { id },
            data: itemData,
            include: ITEM_BRAND_INCLUDE,
          });
    void this.auditService.log({
      action: 'updated',
      entityType: 'item',
      entityId: id,
      summary: `Updated item ${row.sku}`,
    });
    void this.invalidateItemCaches(
      homeTenantId !== requestTenantId ? [homeTenantId] : [],
      { stockChanged: stockFieldsChanged },
    );
    return serializeItem(row);
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.item.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, sku: true, name: true },
    });
    if (!existing) throw new NotFoundException('Item not found');

    await this.tenantDb.db.item.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    void this.auditService.log({
      action: 'deleted',
      entityType: 'item',
      entityId: id,
      summary: `Deleted item ${existing.sku}`,
    });
    void this.invalidateItemCaches([], { stockChanged: true });
  }

  /**
   * Available stock at a source tenant for one SKU — used when planning
   * cross-tenant requisitions (e.g. VA → VW).
   */
  async sourceAvailability(
    sku: string,
    sourceTenantCode: string,
  ): Promise<{
    sku: string;
    sourceTenantCode: string;
    onHand: number;
    reserved: number;
    available: number;
  }> {
    const trimmed = sku.trim();
    if (!trimmed) {
      throw new BadRequestException('sku is required');
    }
    const source = await this.prisma.tenant.findFirst({
      where: { code: sourceTenantCode, deletedAt: null },
      select: { id: true, code: true },
    });
    if (!source) {
      throw new NotFoundException(`Source tenant ${sourceTenantCode} not found`);
    }
    const item = await this.prisma.item.findFirst({
      where: {
        tenantId: source.id,
        sku: trimmed,
        deletedAt: null,
      },
      select: { quantity: true, sku: true },
    });
    const onHand = item?.quantity ?? 0;
    const breakdown = await computeAvailableStock(
      this.prisma,
      source.id,
      item?.sku ?? trimmed,
      onHand,
    );
    return {
      sku: item?.sku ?? trimmed,
      sourceTenantCode: source.code,
      ...breakdown,
    };
  }

  /**
   * Cross-entity stock lookup for the Autos Group. Given a search term, returns
   * matching SKUs and the quantity each auto-group entity holds (with per-location
   * breakdown). Read-only and restricted to auto-group staff + super admins.
   */
  async stockAvailability(
    search?: string,
    options?: {
      limit?: number;
      entityCode?: string;
      availability?: 'all' | 'available' | 'unavailable';
      /** Limit to VW/VISP/VSP product homes (VA/VP consumers default on). */
      stockHomesOnly?: boolean;
    },
  ): Promise<StockAvailabilityResult> {
    const requesterTenantId = this.tenantDb.resolveTenantId();
    let requesterCode: string | null = null;
    // Super admin (null tenant) is always allowed; entity users must belong to
    // the auto-group.
    if (requesterTenantId !== null) {
      const requester = await this.prisma.tenant.findUnique({
        where: { id: requesterTenantId },
        select: { code: true },
      });
      if (!requester || !isAutosGroupCode(requester.code)) {
        throw new ForbiddenException(
          'Cross-entity stock is limited to the Autos Group',
        );
      }
      requesterCode = requester.code;
    }

    const limit = options?.limit ?? 10;
    const entityFilter = options?.entityCode?.trim().toUpperCase();
    const availability = options?.availability ?? 'all';
    const term = search?.trim();
    const stockHomesOnly =
      options?.stockHomesOnly === true ||
      (!entityFilter &&
        (isGroupStockConsumerTenant(requesterCode) ||
          isProductStockLocationCode(requesterCode)));
    const tenantCodes = entityFilter
      ? [entityFilter]
      : stockHomesOnly
        ? [...PRODUCT_STOCK_LOCATION_CODES]
        : [...AUTOS_GROUP_CODES];
    const cacheKey = `stock-availability:v2:${tenantCodes.join(',')}:${availability}:${term ?? ''}:${limit}`;
    const cached = await this.cache.get<StockAvailabilityResult>(cacheKey);
    if (cached) return cached;

    const tenants = await this.prisma.tenant.findMany({
      where: {
        deletedAt: null,
        code: { in: tenantCodes },
      },
      select: { id: true, code: true, name: true },
    });
    const tenantById = new Map(tenants.map((t) => [t.id, t]));

    const items = await this.prisma.item.findMany({
      where: {
        deletedAt: null,
        tenantId: { in: tenants.map((t) => t.id) },
        ...(term
          ? shouldUseFtsListSearch(term)
            ? await (async () => {
                const ftsIds = await fetchItemFtsIds(
                  this.prisma,
                  { in: tenants.map((t) => t.id) },
                  term,
                );
                return ftsIds.length > 0
                  ? { id: { in: ftsIds } }
                  : (itemTextSearchWhere(term) ?? {});
              })()
            : (itemTextSearchWhere(term) ?? {})
          : {}),
      },
      select: {
        id: true,
        tenantId: true,
        sku: true,
        name: true,
        category: true,
        quantity: true,
        reorderPoint: true,
        status: true,
        availableForRetail: true,
        costPrice: true,
        sellPrice: true,
        currency: true,
        locationStock: {
          select: {
            locationCode: true,
            binLocation: true,
            quantity: true,
          },
        },
      },
      orderBy: [{ sku: 'asc' }, { tenantId: 'asc' }],
      take: Math.max(limit * 8, 40),
    });

    const matchedSkus = [...new Set(items.map((item) => item.sku))];
    const reservedByTenant = new Map<string, Map<string, number>>();
    // Only scan requisitions for SKUs that matched — not the whole catalog.
    await Promise.all(
      tenants.map(async (tenant) => {
        reservedByTenant.set(
          tenant.id,
          matchedSkus.length === 0
            ? new Map()
            : await reservedQtyBySku(this.prisma, tenant.id, matchedSkus),
        );
      }),
    );

    const groups = new Map<string, StockAvailabilityResult['groups'][number]>();
    for (const item of items) {
      const tenant = tenantById.get(item.tenantId);
      if (!tenant) continue;
      const key = item.sku;
      const reserved =
        reservedByTenant.get(item.tenantId)?.get(item.sku.toUpperCase()) ?? 0;
      const locSum = item.locationStock.reduce(
        (sum, loc) => sum + loc.quantity,
        0,
      );
      const onHand = Math.max(item.quantity, locSum);
      const { available } = breakdownFromOnHand(onHand, reserved);
      const group =
        groups.get(key) ??
        ({
          sku: item.sku,
          name: item.name,
          category: item.category,
          totalQuantity: 0,
          totalAvailable: 0,
          entities: [],
        } satisfies StockAvailabilityResult['groups'][number]);

      group.totalQuantity += onHand;
      group.totalAvailable += available;
      group.entities.push({
        tenantCode: tenant.code,
        tenantName: tenant.name,
        itemId: item.id,
        quantity: onHand,
        reserved,
        available,
        reorderPoint: item.reorderPoint,
        status: item.status,
        availableForRetail: item.availableForRetail,
        costPrice: toNumber(item.costPrice),
        sellPrice:
          item.sellPrice != null ? toNumber(item.sellPrice) : 0,
        currency: item.currency || 'NGN',
        locations: item.locationStock.map((loc) => ({
          locationCode: loc.locationCode,
          binLocation: loc.binLocation === '' ? null : loc.binLocation,
          quantity: loc.quantity,
        })),
      });
      groups.set(key, group);
    }

    let result = [...groups.values()];
    if (availability === 'available') {
      result = result.filter((g) => g.totalAvailable > 0);
    } else if (availability === 'unavailable') {
      result = result.filter((g) => g.totalAvailable <= 0);
    }

    const payload = { query: term ?? '', groups: result.slice(0, limit) };
    await this.cache.set(cacheKey, payload, 900);
    return payload;
  }

  /**
   * Read-only VW / VISP / VSP quantities for a batch of SKUs.
   * Used on product list/view so stock-home staff can see sister levels
   * without editing another tenant’s catalog.
   */
  async peerStockBySkus(skusRaw: string[]): Promise<PeerStockBySkuResult> {
    const requesterTenantId = this.tenantDb.resolveTenantId();
    if (requesterTenantId !== null) {
      const requester = await this.prisma.tenant.findUnique({
        where: { id: requesterTenantId },
        select: { code: true },
      });
      if (!requester || !isAutosGroupCode(requester.code)) {
        throw new ForbiddenException(
          'Cross-entity stock is limited to the Autos Group',
        );
      }
    }

    const skus = [
      ...new Set(
        skusRaw
          .map((s) => s?.trim())
          .filter((s): s is string => Boolean(s))
          .slice(0, 100),
      ),
    ];
    if (skus.length === 0) {
      return { rows: [] };
    }

    const tenants = await this.prisma.tenant.findMany({
      where: {
        deletedAt: null,
        code: { in: [...PRODUCT_STOCK_LOCATION_CODES] },
      },
      select: { id: true, code: true, name: true },
    });
    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const skuKey = (s: string) => s.trim().toUpperCase();

    const items = await this.prisma.item.findMany({
      where: {
        deletedAt: null,
        tenantId: { in: tenants.map((t) => t.id) },
        OR: skus.map((sku) => ({
          sku: { equals: sku, mode: 'insensitive' as const },
        })),
      },
      select: {
        id: true,
        tenantId: true,
        sku: true,
        quantity: true,
        locationStock: { select: { quantity: true } },
      },
    });

    const matchedSkus = [...new Set(items.map((item) => skuKey(item.sku)))];
    const reservedByTenant = new Map<string, Map<string, number>>();
    await Promise.all(
      tenants.map(async (tenant) => {
        reservedByTenant.set(
          tenant.id,
          matchedSkus.length === 0
            ? new Map()
            : await reservedQtyBySku(this.prisma, tenant.id, matchedSkus),
        );
      }),
    );

    type Cell = {
      itemId: string;
      quantity: number;
      available: number;
    };
    const bySkuCode = new Map<string, Map<string, Cell>>();
    for (const item of items) {
      const tenant = tenantById.get(item.tenantId);
      if (!tenant) continue;
      const locSum = item.locationStock.reduce(
        (sum, loc) => sum + loc.quantity,
        0,
      );
      const onHand = Math.max(item.quantity, locSum);
      const reserved =
        reservedByTenant.get(item.tenantId)?.get(skuKey(item.sku)) ?? 0;
      const { available } = breakdownFromOnHand(onHand, reserved);
      const skuMap =
        bySkuCode.get(skuKey(item.sku)) ?? new Map<string, Cell>();
      skuMap.set(tenant.code, {
        itemId: item.id,
        quantity: onHand,
        available,
      });
      bySkuCode.set(skuKey(item.sku), skuMap);
    }

    const orderedTenants = PRODUCT_STOCK_LOCATION_CODES.map((code) => {
      const tenant = tenants.find((t) => t.code === code);
      return {
        code,
        name: tenant?.name ?? code,
      };
    });

    return {
      rows: skus.map((sku) => {
        const cells = bySkuCode.get(skuKey(sku));
        return {
          sku,
          entities: orderedTenants.map((t) => {
            const cell = cells?.get(t.code);
            return {
              tenantCode: t.code,
              tenantName: t.name,
              itemId: cell?.itemId ?? null,
              quantity: cell?.quantity ?? 0,
              available: cell?.available ?? 0,
            };
          }),
        };
      }),
    };
  }

  async importCsv(csv: string): Promise<CsvImportResult> {
    const rows = parseCsv(csv);
    const result: CsvImportResult = { created: 0, updated: 0, errors: [] };
    if (rows.length === 0) return result;

    if (isHq6ProductCsv(rows)) {
      return this.importHq6ProductCsv(rows);
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const sku = pickCsvField(row, 'sku', 'product sku');
      const name = pickCsvField(row, 'name', 'product name');
      if (!sku || !name) {
        result.errors.push({ row: index + 2, message: 'SKU and name are required' });
        continue;
      }
      const costRaw = pickCsvField(row, 'cost', 'cost price', 'purchase price');
      const costPrice = Number(costRaw || '0');
      if (!Number.isFinite(costPrice) || costPrice < 0) {
        result.errors.push({ row: index + 2, message: 'Invalid cost price' });
        continue;
      }
      try {
        await this.create({
          sku,
          name,
          category: pickCsvField(row, 'category') || undefined,
          // Product import creates catalog rows at qty 0; use Import Opening Stock for qty.
          quantity: 0,
          costPrice,
          currency: pickCsvField(row, 'currency') || 'NGN',
          availableForRetail: true,
        });
        result.created += 1;
      } catch (error) {
        result.errors.push({
          row: index + 2,
          message: error instanceof Error ? error.message : 'Import failed',
        });
      }
    }

    return result;
  }

  private async importHq6ProductCsv(
    rows: Record<string, string>[],
  ): Promise<CsvImportResult> {
    const result: CsvImportResult = { created: 0, updated: 0, errors: [] };
    const tenantId = this.tenantDb.requireTenantId();
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { config: true },
    });
    const config = tenant?.config;
    const locations = businessLocationsFromConfig(config);
    const defaultMargin = Number(
      (config as { businessSettings?: { business?: { defaultProfitPercent?: string } } })
        ?.businessSettings?.business?.defaultProfitPercent ?? 0,
    );

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      try {
        const parsed = parseProductCsvRow(row, index, defaultMargin);
        await this.ensureCatalogMeta({
          brandName: parsed.brandName,
          category: parsed.category,
          subCategory: parsed.subCategory,
          unit: parsed.unit,
          variationName: parsed.variationName,
          variationValues:
            parsed.productType === 'variable' ? parsed.variationValues : undefined,
        });

        let locationCode: string | null =
          resolveBusinessLocationCode(config, parsed.openingStockLocation) ??
          resolveBusinessLocationCode(config, parsed.productLocations[0]) ??
          (locations[0]?.code ?? null);

        for (const variant of parsed.variants) {
          // Catalog import always starts at 0 stock; opening stock is a separate import.
          const locationStock =
            locationCode && parsed.manageStock
              ? [
                  {
                    locationCode,
                    binLocation: variant.binLocation,
                    quantity: 0,
                  },
                ]
              : undefined;

          await this.create({
            sku: variant.sku,
            name: variant.name,
            category: parsed.category,
            subCategory: parsed.subCategory,
            description: parsed.description,
            barcodeType: parsed.barcodeType,
            unit: parsed.unit,
            weight: parsed.weight,
            enableImei: parsed.enableImei,
            quantity: locationStock ? undefined : 0,
            reorderPoint: parsed.alertQuantity,
            costPrice: variant.costPrice,
            sellPrice: variant.sellPrice,
            brandName: parsed.brandName,
            availableForRetail: parsed.availableForRetail,
            locationCode: locationCode ?? undefined,
            binLocation: variant.binLocation,
            locationStock,
          });
          result.created += 1;
        }
      } catch (error) {
        result.errors.push({
          row: index + 2,
          message: error instanceof Error ? error.message : 'Import failed',
        });
      }
    }

    return result;
  }

  /**
   * HQ6 Import Opening Stock — add qty to existing products by SKU,
   * update unit cost, and optionally record lot / expiry in audit metadata.
   */
  async importOpeningStockCsv(csv: string): Promise<CsvImportResult> {
    const rows = parseCsv(csv);
    const result: CsvImportResult = { created: 0, updated: 0, errors: [] };
    if (rows.length === 0) return result;

    const tenantId = this.tenantDb.requireTenantId();
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { config: true },
    });
    const config = tenant?.config;
    const locations = businessLocationsFromConfig(config);
    const defaultLocationCode = locations[0]?.code ?? null;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      try {
        const parsed = parseOpeningStockCsvRow(row);

        const item = await this.tenantDb.db.item.findFirst({
          where: {
            tenantId,
            deletedAt: null,
            sku: { equals: parsed.sku, mode: 'insensitive' },
          },
          select: {
            id: true,
            sku: true,
            quantity: true,
            reorderPoint: true,
            locationCode: true,
            binLocation: true,
            costPrice: true,
          },
        });
        if (!item) {
          throw new Error(`Product with SKU "${parsed.sku}" not found`);
        }

        const locationCode =
          resolveBusinessLocationCode(config, parsed.location) ??
          item.locationCode ??
          defaultLocationCode;

        if (locations.length > 0 && !locationCode) {
          throw new Error('Business location is required');
        }

        const nextQuantity = item.quantity + parsed.quantity;
        const status = deriveStatus(nextQuantity, item.reorderPoint);

        await this.tenantDb.db.$transaction(async (tx) => {
          await tx.item.update({
            where: { id: item.id },
            data: {
              quantity: nextQuantity,
              costPrice: parsed.unitCost,
              status,
              ...(locationCode && !item.locationCode
                ? { locationCode }
                : {}),
            },
          });

          if (locationCode) {
            await adjustItemLocationStock(tx, {
              tenantId,
              itemId: item.id,
              locationCode,
              binLocation: item.binLocation,
              delta: parsed.quantity,
            });
          }
        });

        await this.auditService.log({
          action: 'updated',
          entityType: 'item',
          entityId: item.id,
          summary: `Opening stock +${parsed.quantity} for ${item.sku}`,
          metadata: {
            sku: item.sku,
            quantityAdded: parsed.quantity,
            unitCost: parsed.unitCost,
            locationCode,
            lotNumber: parsed.lotNumber ?? null,
            expiryDate: parsed.expiryDate ?? null,
          },
        });

        result.updated += 1;
      } catch (error) {
        result.errors.push({
          row: index + 2,
          message: error instanceof Error ? error.message : 'Import failed',
        });
      }
    }

    if (result.updated > 0) {
      void this.invalidateItemCaches([], { stockChanged: true });
    }

    return result;
  }

  /** Find-or-create brand / category / unit / variation template from CSV names. */
  private async ensureCatalogMeta(input: {
    brandName?: string;
    category?: string;
    subCategory?: string;
    unit?: string;
    variationName?: string;
    variationValues?: string[];
  }): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const db = this.tenantDb.db;

    if (input.unit?.trim()) {
      const unitName = input.unit.trim();
      const existingUnit = await db.productUnit.findFirst({
        where: {
          tenantId,
          deletedAt: null,
          OR: [
            { name: { equals: unitName, mode: 'insensitive' } },
            { shortName: { equals: unitName, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      if (!existingUnit) {
        const shortName = unitName.slice(0, 8);
        await db.productUnit.create({
          data: { tenantId, name: unitName, shortName },
        });
      }
    }

    let parentCategoryId: string | null = null;
    if (input.category?.trim()) {
      const name = input.category.trim();
      const existing = await db.productCategory.findFirst({
        where: {
          tenantId,
          deletedAt: null,
          parentId: null,
          name: { equals: name, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (existing) {
        parentCategoryId = existing.id;
      } else {
        const created = await db.productCategory.create({
          data: { tenantId, name },
          select: { id: true },
        });
        parentCategoryId = created.id;
      }
    }

    if (input.subCategory?.trim() && parentCategoryId) {
      const name = input.subCategory.trim();
      const existing = await db.productCategory.findFirst({
        where: {
          tenantId,
          deletedAt: null,
          parentId: parentCategoryId,
          name: { equals: name, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (!existing) {
        await db.productCategory.create({
          data: { tenantId, name, parentId: parentCategoryId },
        });
      }
    }

    if (input.variationName?.trim() && input.variationValues?.length) {
      const name = input.variationName.trim();
      const values = input.variationValues.map((v) => v.trim()).filter(Boolean);
      const existing = await db.variationTemplate.findFirst({
        where: {
          tenantId,
          deletedAt: null,
          name: { equals: name, mode: 'insensitive' },
        },
        select: { id: true, values: true },
      });
      if (!existing) {
        await db.variationTemplate.create({
          data: { tenantId, name, values },
        });
      } else {
        const merged = Array.from(new Set([...existing.values, ...values]));
        if (merged.length !== existing.values.length) {
          await db.variationTemplate.update({
            where: { id: existing.id },
            data: { values: merged },
          });
        }
      }
    }
  }

  async bulkUpdatePrice(body: {
    category?: string;
    itemIds?: string[];
    adjustmentType: 'fixed' | 'percentage';
    adjustmentValue: number;
  }): Promise<{ updated: number }> {
    const tenantId = this.tenantDb.requireTenantId();
    if (!Number.isFinite(body.adjustmentValue)) {
      throw new BadRequestException('Invalid adjustment value');
    }

    const items = await this.tenantDb.db.item.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(body.itemIds?.length ? { id: { in: body.itemIds } } : {}),
        ...(body.category
          ? { category: { equals: body.category, mode: 'insensitive' } }
          : {}),
      },
    });

    let updated = 0;
    for (const item of items) {
      const current = toNumber(item.sellPrice ?? 0);
      const next =
        body.adjustmentType === 'percentage'
          ? Math.max(0, current * (1 + body.adjustmentValue / 100))
          : Math.max(0, current + body.adjustmentValue);
      if (next === current) continue;
      await this.tenantDb.db.item.update({
        where: { id: item.id },
        data: { sellPrice: next },
      });
      updated += 1;
    }

    const tenantIdForCache = this.tenantDb.requireTenantId();
    void invalidateTenantDashboardCache(this.cache, tenantIdForCache);

    return { updated };
  }
}
