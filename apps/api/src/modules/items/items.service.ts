import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CsvImportResult,
  Item,
  ItemFilters,
  ItemLocationStockInput,
  KpiSummary,
  StockAvailabilityResult,
  StockStatus,
} from '@vonos/types';
import { AUTOS_GROUP_CODES, isAutosGroupCode } from '@vonos/types';
import { Prisma } from '@prisma/client';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { AuditService } from '../audit/audit.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { resolveListSort } from '../../common/utils/listSort';
import { parseCsv, pickCsvField } from '../../common/utils/csvImport';
import {
  businessLocationsFromConfig,
  resolveBusinessLocationCode,
} from '../../common/utils/businessLocation';
import {
  isHq6ProductCsv,
  parseProductCsvRow,
} from '../../common/utils/productCsvImport';
import { parseOpeningStockCsvRow } from '../../common/utils/openingStockCsvImport';
import { adjustItemLocationStock } from '../../common/utils/itemLocationStock';
import { toNumber } from '../../common/utils/serializers';
import { serializeItem } from './items.mapper';
import {
  breakdownFromOnHand,
  computeAvailableStock,
  reservedQtyBySku,
} from '../../common/utils/availableStock';

interface CreateItemDto {
  sku: string;
  name: string;
  category?: string;
  subCategory?: string;
  description?: string;
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
  sellPrice?: number;
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

  private async invalidateItemCaches(): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    await invalidateTenantDashboardCache(this.cache, tenantId);
  }

  async list(
    filters: ItemFilters & { availableForRetail?: boolean },
  ): Promise<Item[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const db = this.tenantDb.db;
    const limit = filters.limit ?? 10;

    const sort = resolveListSort(filters.sortBy, filters.sortDir, {
      name: { field: 'name', type: 'string' },
      sku: { field: 'sku', type: 'string' },
      quantity: { field: 'quantity', type: 'number' },
      costPrice: { field: 'costPrice', type: 'number' },
      sellingPrice: { field: 'sellingPrice', type: 'number' },
      createdAt: { field: 'createdAt', type: 'date' },
      category: { field: 'category', type: 'string' },
      status: { field: 'status', type: 'string' },
    }, {
      sortField: 'name',
      sortDir: 'asc',
      sortValueType: 'string',
    });

    const pagination = buildCompositeCursorQuery({
      sortField: sort.sortField,
      sortDir: sort.sortDir,
      cursor: filters.cursor,
      limit,
      sortValueType: sort.sortValueType,
    });

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
        ...(filters.search || filters.locationCode
          ? {
              AND: [
                ...(filters.search
                  ? [
                      {
                        OR: [
                          {
                            name: {
                              contains: filters.search,
                              mode: 'insensitive' as const,
                            },
                          },
                          {
                            sku: {
                              contains: filters.search,
                              mode: 'insensitive' as const,
                            },
                          },
                          {
                            category: {
                              contains: filters.search,
                              mode: 'insensitive' as const,
                            },
                          },
                          {
                            binLocation: {
                              contains: filters.search,
                              mode: 'insensitive' as const,
                            },
                          },
                          {
                            locationCode: {
                              contains: filters.search,
                              mode: 'insensitive' as const,
                            },
                          },
                        ],
                      },
                    ]
                  : []),
                ...(filters.locationCode
                  ? [
                      {
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
                      },
                    ]
                  : []),
              ],
            }
          : {}),
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
        ...(filters.locationCode
          ? {
              locationStock: {
                select: {
                  locationCode: true,
                  binLocation: true,
                  quantity: true,
                },
              },
            }
          : {}),
      },
      take: pagination.take,
    });

    return rows.map(serializeItem);
  }

  async getById(id: string): Promise<Item> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.item.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { locationStock: true },
    });
    if (!row) throw new NotFoundException('Item not found');
    return serializeItem(row);
  }

  async getMeta(
    id: string,
  ): Promise<{ id: string; name: string; sku: string }> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.item.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, name: true, sku: true },
    });
    if (!row) throw new NotFoundException('Item not found');
    return row;
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
      unitCost: number | null;
    }>
  > {
    const tenantId = this.tenantDb.requireTenantId();
    const item = await this.tenantDb.db.item.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, sku: true },
    });
    if (!item) throw new NotFoundException('Item not found');

    const movements = await this.tenantDb.db.stockMovement.findMany({
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
      },
    });

    const history: Array<{
      id: string;
      date: string;
      reference: string;
      type: string;
      status: string;
      quantity: number;
      unitCost: number | null;
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
        history.push({
          id: movement.id,
          date: movement.date.toISOString(),
          reference: movement.reference,
          type: movement.type,
          status: movement.status,
          quantity: Number(line.quantity ?? 0),
          unitCost:
            line.unitCost != null ? toNumber(line.unitCost) : null,
        });
      }
      if (history.length >= 100) break;
    }

    return history;
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
    const createdBy = await this.auditService.createdByFields();
    const validate = await this.tenantDb.businessLocationValidator();

    const locationRows =
      dto.locationStock && dto.locationStock.length > 0
        ? normalizeLocationRows(dto.locationStock, validate)
        : [];

    // Primary location/quantity: derived from per-location rows when present,
    // otherwise from the flat fields for backward compatibility.
    const primaryLocation =
      locationRows[0]?.locationCode ?? validate(dto.locationCode);
    const primaryBin =
      locationRows[0]?.binLocation || (dto.binLocation ?? null) || null;
    const quantity =
      locationRows.length > 0
        ? locationRows.reduce((sum, r) => sum + r.quantity, 0)
        : (dto.quantity ?? 0);
    const status = deriveStatus(quantity, dto.reorderPoint, dto.status);

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
      include: { locationStock: true },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'item',
      entityId: row.id,
      summary: `Created item ${row.sku}`,
    });
    void this.invalidateItemCaches();
    return serializeItem(row);
  }

  async update(id: string, dto: UpdateItemDto): Promise<Item> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.item.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Item not found');

    const validate = await this.tenantDb.businessLocationValidator();

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
      derivedPrimaryLocation = locationRows[0]?.locationCode ?? resolvedLocation ?? null;
      derivedPrimaryBin = locationRows[0]?.binLocation || null;
    }

    const nextQuantity =
      derivedQuantity !== undefined
        ? derivedQuantity
        : dto.quantity !== undefined
          ? dto.quantity
          : existing.quantity;

    const nextStatus =
      dto.status !== undefined
        ? dto.status
        : dto.quantity !== undefined ||
            dto.reorderPoint !== undefined ||
            locationRows !== undefined
          ? deriveStatus(nextQuantity, nextReorderPoint)
          : undefined;

    const row = await this.tenantDb.db.$transaction(async (tx) => {
      if (locationRows !== undefined) {
        await tx.itemLocationStock.deleteMany({ where: { itemId: id, tenantId } });
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
      }

      return tx.item.update({
        where: { id },
        data: {
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
          ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
          ...(nextStatus !== undefined ? { status: nextStatus } : {}),
          ...(dto.availableForRetail !== undefined
            ? { availableForRetail: dto.availableForRetail }
            : {}),
        },
        include: { locationStock: true },
      });
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'item',
      entityId: id,
      summary: `Updated item ${row.sku}`,
    });
    void this.invalidateItemCaches();
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
    await this.auditService.log({
      action: 'deleted',
      entityType: 'item',
      entityId: id,
      summary: `Deleted item ${existing.sku}`,
    });
    void this.invalidateItemCaches();
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
    },
  ): Promise<StockAvailabilityResult> {
    const requesterTenantId = this.tenantDb.resolveTenantId();
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
    }

    const limit = options?.limit ?? 10;
    const entityFilter = options?.entityCode?.trim().toUpperCase();
    const availability = options?.availability ?? 'all';
    const term = search?.trim();
    const cacheKey = `stock-availability:${entityFilter ?? 'all'}:${availability}:${term ?? ''}:${limit}`;
    const cached = await this.cache.get<StockAvailabilityResult>(cacheKey);
    if (cached) return cached;

    const tenants = await this.prisma.tenant.findMany({
      where: {
        deletedAt: null,
        ...(entityFilter
          ? { code: entityFilter }
          : { code: { in: [...AUTOS_GROUP_CODES] } }),
      },
      select: { id: true, code: true, name: true },
    });
    const tenantById = new Map(tenants.map((t) => [t.id, t]));

    const items = await this.prisma.item.findMany({
      where: {
        deletedAt: null,
        tenantId: { in: tenants.map((t) => t.id) },
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { sku: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { locationStock: true },
      orderBy: [{ sku: 'asc' }, { tenantId: 'asc' }],
      take: Math.max(limit * 8, 40),
    });

    const reservedByTenant = new Map<string, Map<string, number>>();
    for (const tenant of tenants) {
      reservedByTenant.set(
        tenant.id,
        await reservedQtyBySku(this.prisma, tenant.id),
      );
    }

    const groups = new Map<string, StockAvailabilityResult['groups'][number]>();
    for (const item of items) {
      const tenant = tenantById.get(item.tenantId);
      if (!tenant) continue;
      const key = item.sku;
      const reserved =
        reservedByTenant.get(item.tenantId)?.get(item.sku.toUpperCase()) ?? 0;
      const { available } = breakdownFromOnHand(item.quantity, reserved);
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

      group.totalQuantity += item.quantity;
      group.totalAvailable += available;
      group.entities.push({
        tenantCode: tenant.code,
        tenantName: tenant.name,
        itemId: item.id,
        quantity: item.quantity,
        reserved,
        available,
        reorderPoint: item.reorderPoint,
        status: item.status,
        availableForRetail: item.availableForRetail,
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
          quantity: Number(pickCsvField(row, 'quantity', 'stock') || '0') || 0,
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
          const locationStock =
            locationCode && parsed.manageStock
              ? [
                  {
                    locationCode,
                    binLocation: variant.binLocation,
                    quantity: variant.quantity,
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
            quantity: locationStock ? undefined : variant.quantity,
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
      void this.invalidateItemCaches();
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
      const current = toNumber(item.sellPrice ?? item.costPrice);
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
