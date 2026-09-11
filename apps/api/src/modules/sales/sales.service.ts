import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CsvImportResult,
  PaymentStatus,
  Sale,
  SaleDetail,
  SaleFilters,
  SaleLine,
  SaleStatus,
  SaleViewBundle,
} from '@vonos/types';
import { isGroupStockConsumerTenant, isOutsideOrServiceCatalogItem } from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache, invalidateTenantListCache } from '../../common/cache/cacheInvalidation';
import { refreshCustomerFinancialRollups } from '../../common/utils/customerRollups';
import { applyDailyFinanceDelta } from '../../common/utils/dailyFinanceRollup';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import { applySaleJobStatusNotes } from '../../common/utils/saleJobStatusNotes';
import {
  HQ6_LIST_WARM_LIMITS,
  hq6WarmSorts,
} from '../../common/utils/hq6ListWarm';
import { AuditService } from '../audit/audit.service';
import { InvoiceHubService } from '../invoices/invoice-hub.service';
import { buildCompositeCursorQuery, decodeCompositeCursor } from '../../common/utils/pagination';
import type { PaginatedList } from '../../common/utils/paginatedList';
import { saleTextSearchWhere, saleSearchSql } from '../../common/utils/listSearch';
import { resolveListSort } from '../../common/utils/listSort';
import { computeStockStatus, movementLineRollups } from '../../common/utils/stockQuantity';
import {
  adjustItemLocationStock,
  effectiveItemOnHand,
} from '../../common/utils/itemLocationStock';
import { resolveActiveItem } from '../../common/utils/resolveActiveItem';
import {
  parseCsv,
  pickCsvField,
} from '../../common/utils/csvImport';
import {
  mapSaleStatusToUi,
  saleStatusWhereClause,
  toIso,
  toNumber,
} from '../../common/utils/serializers';
import { paymentStatusFromAmounts } from '../../common/utils/paymentStatus';
import { encodePublicInvoiceToken } from '../../common/utils/publicInvoiceToken';
import {
  recordPaymentAccountTxn,
  softDeletePaymentAccountTxns,
  syncSalePaymentAccountCredit,
} from '../../common/utils/recordPaymentAccountTxn';
import { allocateNextInvoiceNumber } from '../../common/utils/allocateInvoiceNumber';

function normalizeCreateStatus(
  status?: SaleStatus | 'final',
): SaleStatus {
  if (!status || status === 'final') return 'completed';
  return status;
}

function isProvisionalSaleStatus(status: SaleStatus): boolean {
  return status === 'draft' || status === 'quotation';
}

type SaleLineInput = {
  itemId?: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  createPurchase?: boolean;
  sourceTenantCode?: string;
  supplierId?: string;
};

function computeLineTotal(line: {
  quantity: number;
  unitPrice: number;
  discountAmount?: number | null;
}): number {
  const discount = line.discountAmount ?? 0;
  return Math.max(0, line.quantity * line.unitPrice - discount);
}

function buildSaleLineRows(lines: SaleLineInput[]) {
  return lines.map((line) => {
    const discountAmount = line.discountAmount ?? 0;
    const lineTotal = computeLineTotal({ ...line, discountAmount });
    return {
      itemId: line.itemId ?? null,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal,
      discountAmount: discountAmount > 0 ? discountAmount : null,
      sourceTenantCode: line.sourceTenantCode?.trim() || null,
      supplierId: line.supplierId?.trim() || null,
    };
  });
}

function computeSaleTotal(
  lineRows: Array<{ lineTotal: number }>,
  orderDiscount = 0,
  taxAmount = 0,
): number {
  const subtotal = lineRows.reduce((sum, line) => sum + line.lineTotal, 0);
  const discount = Math.min(subtotal, Math.max(0, orderDiscount));
  const tax = Math.max(0, taxAmount);
  return Math.max(0, subtotal - discount + tax);
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cache: CacheService,
    private readonly invoiceHub: InvoiceHubService,
  ) {}

  private refreshSaleSideEffects(options: {
    customerId?: string | null;
    /** When true, only bust sales list caches (quotation/draft). */
    listsOnly?: boolean;
    ledgerEntry?: {
      type: 'revenue' | 'expense';
      amount: number;
      date: Date;
      currency?: string;
    };
  }): void {
    const tenantId = this.tenantDb.requireTenantId();
    if (options.listsOnly) {
      void invalidateTenantListCache(this.cache, tenantId, ['sales:v2', 'sales']);
    } else {
      void invalidateTenantDashboardCache(this.cache, tenantId);
    }
    if (options.ledgerEntry) {
      void applyDailyFinanceDelta(
        this.prisma,
        tenantId,
        options.ledgerEntry.date,
        options.ledgerEntry.type,
        Math.abs(options.ledgerEntry.amount),
        options.ledgerEntry.currency ?? 'NGN',
      );
    }
    if (options.customerId) {
      void refreshCustomerFinancialRollups(this.tenantDb.db, options.customerId);
    }
  }

  /** Apply aggregated on-hand deltas (edit/replace nets zero unchanged lines). */
  private async applyItemStockDeltas(
    tx: Prisma.TransactionClient,
    deltas: Map<
      string,
      {
        itemTenantId: string;
        itemId: string;
        sku: string;
        locationCode: string | null | undefined;
        binLocation: string | null | undefined;
        delta: number;
      }
    >,
  ): Promise<void> {
    const pending = [...deltas.values()].filter((entry) => entry.delta !== 0);
    if (pending.length === 0) return;

    // One round-trip per tenant instead of findFirst-per-line (Neon RTT bound).
    const byTenant = new Map<string, typeof pending>();
    for (const entry of pending) {
      const list = byTenant.get(entry.itemTenantId) ?? [];
      list.push(entry);
      byTenant.set(entry.itemTenantId, list);
    }

    const itemsById = new Map<
      string,
      {
        id: string;
        tenantId: string;
        quantity: { toString(): string };
        reorderPoint: { toString(): string } | null;
        locationCode: string | null;
        binLocation: string | null;
      }
    >();

    for (const [itemTenantId, entries] of byTenant) {
      const rows = await tx.item.findMany({
        where: {
          tenantId: itemTenantId,
          id: { in: entries.map((e) => e.itemId) },
          deletedAt: null,
        },
        select: {
          id: true,
          tenantId: true,
          quantity: true,
          reorderPoint: true,
          locationCode: true,
          binLocation: true,
        },
      });
      for (const row of rows) itemsById.set(row.id, row);
    }

    for (const entry of pending) {
      const item = itemsById.get(entry.itemId);
      if (!item || item.tenantId !== entry.itemTenantId) {
        if (entry.delta < 0) {
          throw new BadRequestException(`Item not found: ${entry.sku}`);
        }
        continue;
      }
      const headerQty = toNumber(item.quantity);
      const onHand =
        entry.delta < 0
          ? await effectiveItemOnHand(tx, item.id, headerQty)
          : headerQty;
      if (entry.delta < 0 && onHand > headerQty) {
        // Heal stale header so convert/sale matches location bins on products.
        await tx.item.update({
          where: { id: item.id },
          data: {
            quantity: onHand,
            status: computeStockStatus(
              onHand,
              item.reorderPoint != null ? toNumber(item.reorderPoint) : null,
            ),
          },
        });
        item.quantity = { toString: () => String(onHand) };
      }
      const nextQuantity = onHand + entry.delta;
      if (nextQuantity < 0) {
        throw new BadRequestException(
          `Insufficient stock for ${entry.sku} (need ${Math.abs(entry.delta)}, have ${onHand})`,
        );
      }
      await tx.item.update({
        where: { id: item.id },
        data: {
          quantity: nextQuantity,
          status: computeStockStatus(
            nextQuantity,
            item.reorderPoint != null ? toNumber(item.reorderPoint) : null,
          ),
        },
      });
      // Keep in-memory qty current if the same item appears twice (shouldn't after Map merge).
      item.quantity = { toString: () => String(nextQuantity) };
      await adjustItemLocationStock(tx, {
        tenantId: entry.itemTenantId,
        itemId: item.id,
        locationCode: entry.locationCode ?? item.locationCode,
        binLocation: entry.binLocation ?? item.binLocation,
        delta: entry.delta,
      });
    }
  }

  private saleOutboundNotesMarker(saleId: string): string {
    return `saleId:${saleId}`;
  }

  private async softDeleteSaleOutboundMovements(
    tx: Prisma.TransactionClient,
    tenantId: string,
    saleId: string,
  ): Promise<void> {
    await tx.stockMovement.updateMany({
      where: {
        tenantId,
        type: 'outbound',
        deletedAt: null,
        notes: { startsWith: this.saleOutboundNotesMarker(saleId) },
      },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Audit trail for sold stock: outbound movement linked via notes saleId:…
   * Only call when qty was actually deducted (not skipStock / provisional).
   */
  private async writeSaleOutboundMovement(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      saleId: string;
      saleReference: string;
      locationCode?: string | null;
      date: Date;
      lines: Array<{
        itemId: string;
        sku: string;
        name: string;
        quantity: number;
        unitCost: number;
      }>;
      createdBy: {
        createdByUserId?: string | null;
        createdByName?: string | null;
      };
    },
  ): Promise<void> {
    if (args.lines.length === 0) return;

    const lines = args.lines.map((line) => ({
      itemId: line.itemId,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitCost: line.unitCost,
      total: line.quantity * line.unitCost,
    }));
    const rollups = movementLineRollups(lines);
    const marker = this.saleOutboundNotesMarker(args.saleId);

    await tx.stockMovement.create({
      data: {
        tenantId: args.tenantId,
        type: 'outbound',
        reference: `SO-${args.saleReference}`,
        status: 'Delivered',
        lines: lines as unknown as Prisma.InputJsonValue,
        itemCount: rollups.itemCount,
        grandTotal: rollups.grandTotal,
        notes: `${marker}|Sale ${args.saleReference}`,
        locationCode: args.locationCode ?? null,
        source: 'standard',
        date: args.date,
        createdByUserId: args.createdBy.createdByUserId ?? null,
        createdByName: args.createdBy.createdByName ?? null,
      },
    });
  }

  private outboundLinesFromStockDeltas(
    stockDeltas: Map<
      string,
      {
        itemId: string;
        sku: string;
        delta: number;
      }
    >,
    lineMeta: Array<{
      itemId?: string;
      sku: string;
      name: string;
      unitPrice: number;
    }>,
  ): Array<{
    itemId: string;
    sku: string;
    name: string;
    quantity: number;
    unitCost: number;
  }> {
    const byItem = new Map(
      lineMeta
        .filter((line) => line.itemId)
        .map((line) => [line.itemId!, line] as const),
    );
    const bySku = new Map(lineMeta.map((line) => [line.sku, line] as const));
    return [...stockDeltas.values()]
      .filter((entry) => entry.delta < 0)
      .map((entry) => {
        const meta = byItem.get(entry.itemId) ?? bySku.get(entry.sku);
        return {
          itemId: entry.itemId,
          sku: entry.sku,
          name: meta?.name ?? entry.sku,
          quantity: Math.abs(entry.delta),
          unitCost: meta?.unitPrice ?? 0,
        };
      });
  }

  private outboundLinesFromSaleLines(
    lines: Array<{
      itemId?: string;
      sku: string;
      name: string;
      quantity: number;
      unitPrice: number;
    }>,
  ): Array<{
    itemId: string;
    sku: string;
    name: string;
    quantity: number;
    unitCost: number;
  }> {
    return lines
      .filter((line) => Boolean(line.itemId))
      .map((line) => {
        const quantity = Math.max(1, Math.round(line.quantity));
        return {
          itemId: line.itemId!,
          sku: line.sku,
          name: line.name,
          quantity,
          unitCost: line.unitPrice,
        };
      });
  }

  async list(filters: SaleFilters): Promise<PaginatedList<Sale>> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      from: filters.from,
      to: filters.to,
      locationCode: filters.locationCode,
      customerId: filters.customerId,
      jobId: filters.jobId,
      paymentStatus: filters.paymentStatus,
      paymentMethod: filters.paymentMethod,
      cleanerUserId: filters.cleanerUserId,
      serviceStaffEmployeeId: filters.serviceStaffEmployeeId,
      createdByUserId: filters.createdByUserId,
      status: filters.status,
      saleStatus: filters.saleStatus,
      returnsOnly: filters.returnsOnly ? 1 : 0,
      shipmentsOnly: filters.shipmentsOnly ? 1 : 0,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
      sum: filters.includeSummary === false ? 0 : 1,
    });

    return withListPageCache(
      this.cache,
      tenantId,
      'sales:v2',
      filterKey,
      () => this.listUncached(filters, tenantId),
      600,
    );
  }

  private async listUncached(
    filters: SaleFilters,
    tenantId: string,
  ): Promise<PaginatedList<Sale>> {
    const startedAt = Date.now();
    const sort = resolveListSort(filters.sortBy, filters.sortDir, {
      date: { field: 'date', type: 'date' },
      reference: { field: 'reference', type: 'string' },
      total: { field: 'total', type: 'number' },
      paymentStatus: { field: 'paymentStatus', type: 'string' },
      status: { field: 'status', type: 'string' },
      createdAt: { field: 'createdAt', type: 'date' },
      updatedAt: { field: 'updatedAt', type: 'date' },
    }, {
      sortField: 'updatedAt',
      sortDir: 'desc',
      sortValueType: 'date',
    });
    const limit = Math.min(Math.max(filters.limit ?? 10, 1), 100);
    const search = filters.search?.trim();
    const includeSummary = filters.includeSummary !== false;

    // Fast path: one SQL round-trip for the page (joins + paid + line count).
    // Non-date cursors stay on Prisma. Search uses the same SQL with ILIKE
    // on indexed reference / customer / job columns.
    const canFastPath =
      !filters.cursor ||
      ((sort.sortField === 'date' ||
        sort.sortField === 'updatedAt' ||
        sort.sortField === 'createdAt') &&
        sort.sortValueType === 'date');
    if (canFastPath) {
      const page = await this.listSalesPageRaw(tenantId, filters, sort, limit);
      let totalCount: number | undefined;
      let totalAmount: number | undefined;
      if (includeSummary) {
        const summary = await this.salesListSummaryCached(tenantId, filters);
        totalCount = summary.totalCount;
        totalAmount = summary.totalAmount;
      }

      const ms = Date.now() - startedAt;
      if (ms > 500) {
        this.logger.warn(
          `list ${ms}ms tenant=${tenantId} rows=${page.length} search=${search ? 1 : 0} fast=1`,
        );
      }

      if (!includeSummary || totalCount == null || totalAmount == null) {
        return {
          items: page,
          hasMore: page.length >= limit,
          pageSize: limit,
        };
      }
      return {
        items: page,
        hasMore: page.length >= limit,
        pageSize: limit,
        totalCount,
        amountSummary: {
          totalAmount,
          currency: 'NGN',
        },
      };
    }

    const dateFilter =
      filters.from || filters.to
        ? {
            date: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {};
    const pagination = buildCompositeCursorQuery({
      sortField: sort.sortField,
      sortDir: sort.sortDir,
      cursor: filters.cursor,
      limit,
      sortValueType: sort.sortValueType,
    });

    const searchWhere = saleTextSearchWhere(search);
    const andClauses: Prisma.SaleWhereInput[] = [
      ...(searchWhere?.AND ?? []),
    ];
    if (filters.paymentMethod?.trim()) {
      const method = filters.paymentMethod.trim();
      andClauses.push({
        OR: [
          {
            paymentMethod: { equals: method, mode: 'insensitive' },
          },
          {
            payments: {
              some: {
                deletedAt: null,
                method: { equals: method, mode: 'insensitive' },
              },
            },
          },
        ],
      });
    }

    const baseWhere: Prisma.SaleWhereInput = {
      tenantId,
      deletedAt: null,
      ...saleStatusWhereClause(filters),
      ...dateFilter,
      ...(filters.locationCode
        ? {
            locationCode: {
              equals: filters.locationCode,
              mode: 'insensitive',
            },
          }
        : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.paymentStatus
        ? { paymentStatus: filters.paymentStatus }
        : {}),
      ...(filters.cleanerUserId
        ? { cleanerUserId: filters.cleanerUserId }
        : {}),
      ...(filters.serviceStaffEmployeeId
        ? { serviceStaffEmployeeId: filters.serviceStaffEmployeeId }
        : {}),
      ...(filters.createdByUserId
        ? { createdByUserId: filters.createdByUserId }
        : {}),
      ...(andClauses.length > 0 ? { AND: andClauses } : {}),
    };

    const [rows, totalCount, saleAmountAgg] = await Promise.all([
      this.tenantDb.db.sale.findMany({
        where: {
          ...baseWhere,
          ...(pagination.where ?? {}),
        },
        select: {
          id: true,
          tenantId: true,
          reference: true,
          customerId: true,
          customer: { select: { name: true, phone: true } },
          jobId: true,
          job: { select: { reference: true } },
          total: true,
          discountAmount: true,
          taxAmount: true,
          notes: true,
          originalSaleId: true,
          currency: true,
          status: true,
          paymentStatus: true,
          paymentMethod: true,
          cleanerUserId: true,
          cleanerName: true,
          serviceStaffEmployeeId: true,
          serviceStaffEmployee: { select: { name: true } },
          locationCode: true,
          shippingStatus: true,
          shippingAddress: true,
          trackingNumber: true,
          date: true,
          createdByUserId: true,
          createdByName: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ [sort.sortField]: sort.sortDir }, { id: sort.sortDir }],
        take: pagination.take,
      }),
      includeSummary
        ? this.tenantDb.db.sale.count({ where: baseWhere })
        : Promise.resolve(undefined as number | undefined),
      includeSummary
        ? this.tenantDb.db.sale.aggregate({
            where: baseWhere,
            _sum: { total: true },
          })
        : Promise.resolve(undefined),
    ]);

    const saleIds = rows.map((r) => r.id);
    const [paymentMeta, lineCounts] = await Promise.all([
      this.paymentMetaForSales(saleIds),
      this.lineCountsForSales(saleIds),
    ]);

    const mapRow = (row: (typeof rows)[number]) =>
      this.toSale(
        {
          ...row,
          _count: { lines: lineCounts.get(row.id) ?? 0 },
        },
        paymentMeta.paid.get(row.id) ?? 0,
        paymentMeta.notes.get(row.id) ?? null,
      );

    const ms = Date.now() - startedAt;
    if (ms > 500) {
      this.logger.warn(
        `list ${ms}ms tenant=${tenantId} rows=${rows.length} search=1`,
      );
    }

    if (!includeSummary || totalCount == null || saleAmountAgg == null) {
      return { items: rows.map(mapRow) };
    }

    return {
      items: rows.map(mapRow),
      totalCount,
      amountSummary: {
        totalAmount: toNumber(saleAmountAgg._sum.total),
        currency: 'NGN',
      },
    };
  }

  /**
   * Single-round-trip sales page: Sale + Customer + Job + paid sum + line count.
   * Avoids Prisma relation fan-out (was ~3s) + follow-up payment queries (~5s).
   */
  private async listSalesPageRaw(
    tenantId: string,
    filters: SaleFilters,
    sort: { sortField: string; sortDir: 'asc' | 'desc'; sortValueType: string },
    limit: number,
  ): Promise<Sale[]> {
    const sortCol =
      sort.sortField === 'reference'
        ? 's.reference'
        : sort.sortField === 'total'
          ? 's.total'
          : sort.sortField === 'paymentStatus'
            ? 's."paymentStatus"'
            : sort.sortField === 'status'
              ? 's.status'
              : sort.sortField === 'createdAt'
                ? 's."createdAt"'
                : sort.sortField === 'updatedAt'
                  ? 's."updatedAt"'
                  : 's.date';
    const sortDirSql = sort.sortDir === 'asc' ? 'ASC' : 'DESC';

    const cursor = decodeCompositeCursor(filters.cursor);
    const cursorDate =
      cursor?.sortValue && sort.sortValueType === 'date'
        ? new Date(cursor.sortValue)
        : null;
    const cursorId = cursor?.id ?? null;
    const sortDesc = sort.sortDir === 'desc';

    const rows = await this.tenantDb.db.$queryRaw<
      Array<{
        id: string;
        tenantId: string;
        reference: string;
        customerId: string | null;
        customer_name: string | null;
        customer_phone: string | null;
        jobId: string | null;
        job_ref: string | null;
        total: number;
        discountAmount: number | null;
        taxAmount: number | null;
        notes: string | null;
        originalSaleId: string | null;
        currency: string;
        status: string;
        paymentStatus: string | null;
        paymentMethod: string | null;
        cleanerUserId: string | null;
        cleanerName: string | null;
        serviceStaffEmployeeId: string | null;
        service_staff_name: string | null;
        locationCode: string | null;
        shippingStatus: string | null;
        shippingAddress: string | null;
        trackingNumber: string | null;
        date: Date;
        createdByUserId: string | null;
        createdByName: string | null;
        createdAt: Date;
        updatedAt: Date;
        totalPaid: number;
        itemCount: number;
      }>
    >`
      SELECT
        s.id, s."tenantId", s.reference, s."customerId",
        c.name AS customer_name, c.phone AS customer_phone,
        s."jobId", j.reference AS job_ref,
        s.total::float AS total,
        s."discountAmount"::float AS "discountAmount",
        s."taxAmount"::float AS "taxAmount",
        s.notes, s."originalSaleId", s.currency, s.status::text AS status,
        s."paymentStatus"::text AS "paymentStatus", s."paymentMethod",
        s."cleanerUserId", s."cleanerName", s."serviceStaffEmployeeId",
        e.name AS service_staff_name,
        s."locationCode", s."shippingStatus", s."shippingAddress", s."trackingNumber",
        s.date, s."createdByUserId", s."createdByName", s."createdAt", s."updatedAt",
        COALESCE(s."totalPaid", 0)::float AS "totalPaid",
        COALESCE(s."itemCount", 0)::int AS "itemCount"
      FROM "Sale" s
      LEFT JOIN "Customer" c ON c.id = s."customerId"
      LEFT JOIN "Job" j ON j.id = s."jobId"
      LEFT JOIN "Employee" e ON e.id = s."serviceStaffEmployeeId"
      WHERE s."tenantId" = ${tenantId}
        AND s."deletedAt" IS NULL
        AND (${filters.from ?? null}::timestamptz IS NULL OR s.date >= ${filters.from ? new Date(filters.from) : null}::timestamptz)
        AND (${filters.to ?? null}::timestamptz IS NULL OR s.date <= ${filters.to ? new Date(filters.to) : null}::timestamptz)
        AND (${filters.locationCode ?? null}::text IS NULL OR lower(coalesce(s."locationCode", '')) = lower(${filters.locationCode ?? null}))
        AND (${filters.customerId ?? null}::text IS NULL OR s."customerId" = ${filters.customerId ?? null})
        AND (${filters.jobId ?? null}::text IS NULL OR s."jobId" = ${filters.jobId ?? null})
        AND (${filters.paymentStatus ?? null}::text IS NULL OR s."paymentStatus"::text = ${filters.paymentStatus ?? null})
        AND (
          ${filters.paymentMethod ?? null}::text IS NULL
          OR lower(coalesce(s."paymentMethod", '')) = lower(${filters.paymentMethod ?? null})
          OR EXISTS (
            SELECT 1 FROM "Payment" p
            WHERE p."saleId" = s.id
              AND p."deletedAt" IS NULL
              AND lower(coalesce(p.method, '')) = lower(${filters.paymentMethod ?? null})
          )
        )
        AND (${filters.cleanerUserId ?? null}::text IS NULL OR s."cleanerUserId" = ${filters.cleanerUserId ?? null})
        AND (${filters.serviceStaffEmployeeId ?? null}::text IS NULL OR s."serviceStaffEmployeeId" = ${filters.serviceStaffEmployeeId ?? null})
        AND (${filters.createdByUserId ?? null}::text IS NULL OR s."createdByUserId" = ${filters.createdByUserId ?? null})
        AND (
          ${filters.shipmentsOnly ? true : false} = false
          OR s."shippingStatus" IS NOT NULL
        )
        AND (
          ${filters.saleStatus ?? null}::text IS NOT NULL
            AND s.status::text = ${filters.saleStatus ?? null}
          OR (
            ${filters.saleStatus ?? null}::text IS NULL
            AND s.status::text NOT IN ('draft', 'quotation')
          )
        )
        AND (
          ${cursorId}::text IS NULL
          OR (
            ${sortDesc} = true
            AND (
              ${Prisma.raw(sortCol)} < ${cursorDate}
              OR (${Prisma.raw(sortCol)} = ${cursorDate} AND s.id < ${cursorId})
            )
          )
          OR (
            ${sortDesc} = false
            AND (
              ${Prisma.raw(sortCol)} > ${cursorDate}
              OR (${Prisma.raw(sortCol)} = ${cursorDate} AND s.id > ${cursorId})
            )
          )
        )
        AND ${saleSearchSql(filters.search)}
      ORDER BY ${Prisma.raw(sortCol)} ${Prisma.raw(sortDirSql)}, s.id ${Prisma.raw(sortDirSql)}
      LIMIT ${limit}
    `;

    return rows.map((row) => {
      const total = Number(row.total ?? 0);
      const totalPaid = Number(row.totalPaid ?? 0);
      const sellDue = Math.max(0, total - totalPaid);
      return {
        id: row.id,
        tenantId: row.tenantId,
        reference: row.reference,
        customerId: row.customerId,
        customerName: row.customer_name ?? 'Walk-in',
        customerPhone: row.customer_phone ?? null,
        jobId: row.jobId,
        jobReference: row.job_ref ?? null,
        total,
        discountAmount:
          row.discountAmount != null ? Number(row.discountAmount) : null,
        taxAmount: row.taxAmount != null ? Number(row.taxAmount) : null,
        notes: row.notes,
        paymentNote: null,
        originalSaleId: row.originalSaleId,
        originalSaleReference: null,
        currency: row.currency,
        status: mapSaleStatusToUi(row.status),
        recordStatus: row.status as Sale['recordStatus'],
        paymentStatus: paymentStatusFromAmounts(
          total,
          totalPaid,
          row.paymentStatus,
        ),
        paymentMethod: row.paymentMethod,
        totalPaid,
        sellDue,
        cleanerUserId: row.cleanerUserId,
        cleanerName: row.cleanerName,
        serviceStaffEmployeeId: row.serviceStaffEmployeeId,
        serviceStaffEmployeeName:
          row.service_staff_name?.trim() || row.cleanerName || null,
        locationCode: row.locationCode,
        shippingStatus: row.shippingStatus as Sale['shippingStatus'],
        shippingAddress: row.shippingAddress,
        trackingNumber: row.trackingNumber,
        itemCount: Number(row.itemCount ?? 0),
        date: toIso(row.date).slice(0, 10),
        createdByUserId: row.createdByUserId,
        createdByName: row.createdByName,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      };
    });
  }

  /** Count + sum with a longer cache — full-table scan on Neon is ~3–15s cold. */
  private async salesListSummaryCached(
    tenantId: string,
    filters: SaleFilters,
  ): Promise<{ totalCount: number; totalAmount: number }> {
    const filterKey = listPageFilterKey({
      search: filters.search,
      from: filters.from,
      to: filters.to,
      locationCode: filters.locationCode,
      customerId: filters.customerId,
      jobId: filters.jobId,
      paymentStatus: filters.paymentStatus,
      paymentMethod: filters.paymentMethod,
      cleanerUserId: filters.cleanerUserId,
      serviceStaffEmployeeId: filters.serviceStaffEmployeeId,
      createdByUserId: filters.createdByUserId,
      status: filters.status,
      saleStatus: filters.saleStatus,
      returnsOnly: filters.returnsOnly ? 1 : 0,
      shipmentsOnly: filters.shipmentsOnly ? 1 : 0,
      kind: 'summary',
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'sales-summary',
      filterKey,
      async () => {
        const rows = await this.tenantDb.db.$queryRaw<
          Array<{ c: number; s: number }>
        >`
          SELECT COUNT(*)::int AS c, COALESCE(SUM(s.total), 0)::float AS s
          FROM "Sale" s
          LEFT JOIN "Customer" c ON c.id = s."customerId"
          LEFT JOIN "Job" j ON j.id = s."jobId"
          WHERE s."tenantId" = ${tenantId}
            AND s."deletedAt" IS NULL
            AND (${filters.from ?? null}::timestamptz IS NULL OR s.date >= ${filters.from ? new Date(filters.from) : null}::timestamptz)
            AND (${filters.to ?? null}::timestamptz IS NULL OR s.date <= ${filters.to ? new Date(filters.to) : null}::timestamptz)
            AND (${filters.locationCode ?? null}::text IS NULL OR lower(coalesce(s."locationCode", '')) = lower(${filters.locationCode ?? null}))
            AND (${filters.customerId ?? null}::text IS NULL OR s."customerId" = ${filters.customerId ?? null})
            AND (${filters.jobId ?? null}::text IS NULL OR s."jobId" = ${filters.jobId ?? null})
            AND (${filters.paymentStatus ?? null}::text IS NULL OR s."paymentStatus"::text = ${filters.paymentStatus ?? null})
            AND (
              ${filters.paymentMethod ?? null}::text IS NULL
              OR lower(coalesce(s."paymentMethod", '')) = lower(${filters.paymentMethod ?? null})
              OR EXISTS (
                SELECT 1 FROM "Payment" p
                WHERE p."saleId" = s.id
                  AND p."deletedAt" IS NULL
                  AND lower(coalesce(p.method, '')) = lower(${filters.paymentMethod ?? null})
              )
            )
            AND (${filters.cleanerUserId ?? null}::text IS NULL OR s."cleanerUserId" = ${filters.cleanerUserId ?? null})
            AND (${filters.serviceStaffEmployeeId ?? null}::text IS NULL OR s."serviceStaffEmployeeId" = ${filters.serviceStaffEmployeeId ?? null})
            AND (${filters.createdByUserId ?? null}::text IS NULL OR s."createdByUserId" = ${filters.createdByUserId ?? null})
            AND (
              ${filters.shipmentsOnly ? true : false} = false
              OR s."shippingStatus" IS NOT NULL
            )
            AND (
              ${filters.saleStatus ?? null}::text IS NOT NULL
                AND s.status::text = ${filters.saleStatus ?? null}
              OR (
                ${filters.saleStatus ?? null}::text IS NULL
                AND s.status::text NOT IN ('draft', 'quotation')
              )
            )
            AND ${saleSearchSql(filters.search)}
        `;
        return {
          totalCount: Number(rows[0]?.c ?? 0),
          totalAmount: Number(rows[0]?.s ?? 0),
        };
      },
      900,
    );
  }

  /**
   * Batch payment amounts + notes for a page of sales.
   * One aggregate SQL round-trip (saleId + invoice-linked) — not N payment rows.
   */
  private async paymentMetaForSales(
    saleIds: string[],
    opts?: { includeNotes?: boolean },
  ): Promise<{ paid: Map<string, number>; notes: Map<string, string> }> {
    const paid = new Map<string, number>();
    const notes = new Map<string, string>();
    if (saleIds.length === 0) return { paid, notes };
    const includeNotes = opts?.includeNotes !== false;

    if (!includeNotes) {
      const rows = await this.tenantDb.db.$queryRaw<
        Array<{ sid: string; paid: number | null }>
      >`
        SELECT sid, SUM(amt)::float AS paid
        FROM (
          SELECT pay."saleId" AS sid, pay.amount AS amt
          FROM "Payment" pay
          WHERE pay."deletedAt" IS NULL
            AND pay."isReturn" = false
            AND pay."saleId" IN (${Prisma.join(saleIds)})
          UNION ALL
          SELECT i."saleId" AS sid, pay.amount AS amt
          FROM "Payment" pay
          JOIN "Invoice" i ON i.id = pay."invoiceId" AND i."deletedAt" IS NULL
          WHERE pay."deletedAt" IS NULL
            AND pay."isReturn" = false
            AND pay."saleId" IS NULL
            AND i."saleId" IN (${Prisma.join(saleIds)})
        ) x
        WHERE sid IS NOT NULL
        GROUP BY sid
      `;
      for (const row of rows) {
        if (!row.sid) continue;
        paid.set(row.sid, Number(row.paid ?? 0));
      }
      return { paid, notes };
    }

    const rows = await this.tenantDb.db.$queryRaw<
      Array<{ sid: string; paid: number | null; notes: string | null }>
    >`
      SELECT sid,
        SUM(amt)::float AS paid,
        STRING_AGG(DISTINCT note, ', ')
          FILTER (WHERE note IS NOT NULL AND note <> '') AS notes
      FROM (
        SELECT pay."saleId" AS sid, pay.amount AS amt, NULLIF(TRIM(pay.note), '') AS note
        FROM "Payment" pay
        WHERE pay."deletedAt" IS NULL
          AND pay."isReturn" = false
          AND pay."saleId" IN (${Prisma.join(saleIds)})
        UNION ALL
        SELECT i."saleId" AS sid, pay.amount AS amt, NULLIF(TRIM(pay.note), '') AS note
        FROM "Payment" pay
        JOIN "Invoice" i ON i.id = pay."invoiceId" AND i."deletedAt" IS NULL
        WHERE pay."deletedAt" IS NULL
          AND pay."isReturn" = false
          AND pay."saleId" IS NULL
          AND i."saleId" IN (${Prisma.join(saleIds)})
      ) x
      WHERE sid IS NOT NULL
      GROUP BY sid
    `;

    for (const row of rows) {
      if (!row.sid) continue;
      paid.set(row.sid, Number(row.paid ?? 0));
      if (row.notes?.trim()) notes.set(row.sid, row.notes.trim());
    }
    return { paid, notes };
  }

  /** Line counts for a page — one GROUP BY instead of per-row `_count`. */
  private async lineCountsForSales(
    saleIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (saleIds.length === 0) return map;
    const rows = await this.tenantDb.db.$queryRaw<
      Array<{ saleId: string; c: number }>
    >`
      SELECT "saleId", COUNT(*)::int AS c
      FROM "SaleLine"
      WHERE "saleId" IN (${Prisma.join(saleIds)})
      GROUP BY "saleId"
    `;
    for (const row of rows) map.set(row.saleId, row.c);
    return map;
  }

  async getById(id: string): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        customer: {
          select: {
            name: true,
            email: true,
            phone: true,
            totalSellDue: true,
          },
        },
        job: { select: { reference: true, vehicleId: true, createdAt: true } },
        serviceStaffEmployee: { select: { name: true } },
        lines: true,
        originalSale: { select: { reference: true } },
        payments: {
          where: { deletedAt: null },
          select: { amount: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Sale not found');

    let vehicleLabel: string | null = null;
    if (row.job?.vehicleId) {
      const vehicle = await this.tenantDb.db.vehicle.findFirst({
        where: {
          id: row.job.vehicleId,
          tenantId,
          deletedAt: null,
        },
        select: { make: true, model: true, plateNumber: true },
      });
      if (vehicle) {
        vehicleLabel = `${vehicle.make}-${vehicle.model} ${vehicle.plateNumber}`.trim();
      }
    }

    return this.toSaleDetail({
      ...row,
      job: row.job
        ? { reference: row.job.reference, vehicleLabel }
        : null,
    });
  }

  /** Modal bundle: sale + payments + activity — DB work parallelized. */
  async getView(id: string): Promise<SaleViewBundle> {
    const tenantId = this.tenantDb.requireTenantId();

    const [row, paymentRows, activities] = await Promise.all([
      this.tenantDb.db.sale.findFirst({
        where: { id, tenantId, deletedAt: null },
        include: {
          customer: {
            select: {
              name: true,
              email: true,
              phone: true,
              totalSellDue: true,
            },
          },
          job: {
            select: { reference: true, vehicleId: true, createdAt: true },
          },
          serviceStaffEmployee: { select: { name: true } },
          lines: true,
          originalSale: { select: { reference: true } },
        },
      }),
      this.listSalePaymentRows(id, tenantId),
      this.auditService.list({
        entityType: 'sale',
        entityId: id,
        limit: 20,
      }),
    ]);
    if (!row) throw new NotFoundException('Sale not found');

    let vehicleLabel: string | null = null;
    if (row.job?.vehicleId) {
      const vehicle = await this.tenantDb.db.vehicle.findFirst({
        where: {
          id: row.job.vehicleId,
          tenantId,
          deletedAt: null,
        },
        select: { make: true, model: true, plateNumber: true },
      });
      if (vehicle) {
        vehicleLabel =
          `${vehicle.make}-${vehicle.model} ${vehicle.plateNumber}`.trim();
      }
    }

    const paidTotal = paymentRows.reduce(
      (sum, payment) => sum + toNumber(payment.amount),
      0,
    );

    const sale = this.toSaleDetail({
      ...row,
      payments: paymentRows.map((p) => ({ amount: p.amount })),
      job: row.job
        ? { reference: row.job.reference, vehicleLabel }
        : null,
    });
    sale.totalPaid = paidTotal;
    sale.sellDue = Math.max(0, sale.total - paidTotal);
    sale.paymentStatus = paymentStatusFromAmounts(
      sale.total,
      paidTotal,
      sale.paymentStatus,
    );

    const payments = paymentRows.map((payment) => ({
      id: payment.id,
      amount: toNumber(payment.amount),
      currency: payment.currency,
      method: payment.method,
      paymentRefNo: payment.paymentRefNo,
      paidOn: payment.paidOn ? toIso(payment.paidOn) : null,
      note: payment.note,
      accountId: payment.accountId,
      accountName: payment.account?.name ?? null,
      createdByName: payment.createdByName,
    }));

    return { sale, payments, activities };
  }

  async getMeta(id: string): Promise<{ id: string; reference: string }> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, reference: true },
    });
    if (!row) throw new NotFoundException('Sale not found');
    return row;
  }

  async create(body: {
    reference?: string;
    customerName?: string;
    customerId?: string;
    jobId?: string;
    locationCode?: string;
    paymentMethod?: string;
    cleanerUserId?: string;
    cleanerName?: string;
    serviceStaffEmployeeId?: string;
    lines: SaleLineInput[];
    currency?: string;
    date?: string;
    status?: SaleStatus | 'final';
    shippingStatus?: string;
    shippingAddress?: string;
    trackingNumber?: string;
    discountAmount?: number;
    taxAmount?: number;
    notes?: string;
    payments?: Array<{
      amount: number;
      method?: string;
      note?: string;
      accountId?: string;
    }>;
  }): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();

    const [createdBy, resolvedLocation] = await Promise.all([
      this.auditService.createdByFields(),
      this.tenantDb.resolveBusinessLocation(body.locationCode),
    ]);
    let locationCode = resolvedLocation;
    const currency = body.currency ?? 'NGN';
    const saleDate = body.date ? new Date(body.date) : new Date();
    const status = normalizeCreateStatus(body.status);
    const isProvisional = status === 'draft' || status === 'quotation';

    let jobId: string | null = body.jobId?.trim() || null;
    let linkedJob: {
      id: string;
      reference: string;
      customerId: string | null;
      customerName: string | null;
      locationCode: string | null;
      invoiceAmount: { toString(): string } | null;
      materials: Array<{
        itemId: string | null;
        name: string;
        quantity: { toString(): string };
        unitCost: { toString(): string };
      }>;
      labourEntries: Array<{
        hours: { toString(): string };
        rate: { toString(): string };
        totalCost: { toString(): string };
        staffId: string;
      }>;
    } | null = null;

    if (jobId) {
      const [job, existingForJob] = await Promise.all([
        this.tenantDb.db.job.findFirst({
          where: { id: jobId, tenantId, deletedAt: null },
          select: {
            id: true,
            reference: true,
            customerId: true,
            customerName: true,
            locationCode: true,
            invoiceAmount: true,
            materials: {
              select: {
                itemId: true,
                name: true,
                quantity: true,
                unitCost: true,
              },
            },
            labourEntries: {
              select: {
                hours: true,
                rate: true,
                totalCost: true,
                staffId: true,
              },
            },
          },
        }),
        this.tenantDb.db.sale.findFirst({
          where: {
            tenantId,
            jobId,
            deletedAt: null,
          },
          select: { id: true, reference: true },
        }),
      ]);
      linkedJob = job;
      if (!linkedJob) {
        throw new BadRequestException('Job not found');
      }
      if (existingForJob) {
        throw new BadRequestException(
          `Job ${linkedJob.reference} already has sale ${existingForJob.reference}`,
        );
      }
      if (!locationCode && linkedJob.locationCode) {
        locationCode = linkedJob.locationCode;
      }
    }

    let serviceStaffEmployeeId: string | null = null;
    let cleanerUserId = body.cleanerUserId?.trim() || null;
    let cleanerName = body.cleanerName?.trim() || null;

    const employeeIdInput = body.serviceStaffEmployeeId?.trim();
    const customerIdInput = body.customerId?.trim();
    const customerNameHint = (
      body.customerName ??
      linkedJob?.customerName ??
      ''
    ).trim();

    const [employeeRow, customerById, customerByName] = await Promise.all([
      employeeIdInput
        ? this.tenantDb.db.employee.findFirst({
            where: { id: employeeIdInput, tenantId, deletedAt: null },
            select: { id: true, name: true, userId: true },
          })
        : Promise.resolve(null),
      customerIdInput
        ? this.tenantDb.db.customer.findFirst({
            where: { id: customerIdInput, tenantId, deletedAt: null },
          })
        : Promise.resolve(null),
      !customerIdInput && customerNameHint
        ? this.tenantDb.db.customer.findFirst({
            where: {
              tenantId,
              deletedAt: null,
              name: { equals: customerNameHint, mode: 'insensitive' },
            },
          })
        : Promise.resolve(null),
    ]);

    if (employeeIdInput) {
      if (!employeeRow) {
        throw new BadRequestException('Service staff employee not found');
      }
      serviceStaffEmployeeId = employeeRow.id;
      cleanerName = cleanerName || employeeRow.name;
      cleanerUserId = cleanerUserId || employeeRow.userId;
    }

    let customerId: string | null = null;
    if (customerIdInput) {
      if (!customerById) {
        throw new BadRequestException('Customer not found');
      }
      customerId = customerById.id;
    } else if (linkedJob?.customerId) {
      customerId = linkedJob.customerId;
    } else if (customerNameHint) {
      if (customerByName) {
        customerId = customerByName.id;
      } else {
        const customer = await this.tenantDb.db.customer.create({
          data: {
            tenantId,
            name: customerNameHint,
            ...createdBy,
          },
        });
        customerId = customer.id;
      }
    }

    let workingLines: SaleLineInput[] = body.lines.map((line) => ({ ...line }));
    if (workingLines.length === 0 && linkedJob) {
      workingLines = this.linesFromJob(linkedJob);
    }
    if (workingLines.length === 0) {
      throw new BadRequestException('Add at least one line item');
    }

    const orderDiscount = body.discountAmount ?? 0;
    const taxAmount = body.taxAmount ?? 0;
    /** Job materials already moved stock — do not deduct again on the sale. */
    const sellingTenant = await this.tenantDb.getTenantCodeAndConfig();
    /** VA/VP: price catalog only — never deduct/validate stock (local or VW/VISP/VSP).
     * Staff can still source parts outside; zero stock must not block quotes/sales. */
    const skipStock =
      Boolean(jobId) ||
      isGroupStockConsumerTenant(sellingTenant?.code);

    const paymentRows =
      !isProvisional && body.payments && body.payments.length > 0
        ? body.payments
        : isProvisional
          ? []
          : [{ amount: 0, method: 'cash' }];

    const explicitReference = body.reference?.trim() || null;
    let saleReference = explicitReference;
    if (!saleReference) {
      saleReference = await allocateNextInvoiceNumber(
        this.tenantDb.db,
        tenantId,
      );
    }

    // Provisional create: single insert, no interactive tx / stock /
    // payments. Invoice hub runs after response. List-only cache bust so hq6/reports
    // stay warm.
    if (isProvisional) {
      const lineData = buildSaleLineRows(workingLines);
      const total = computeSaleTotal(lineData, orderDiscount, taxAmount);
      try {
        const row = await this.tenantDb.db.sale.create({
          data: {
            tenantId,
            reference: saleReference,
            customerId,
            jobId,
            total,
            discountAmount: orderDiscount > 0 ? orderDiscount : null,
            taxAmount: taxAmount > 0 ? taxAmount : null,
            notes: body.notes?.trim() || null,
            currency,
            status,
            paymentStatus: 'due',
            paymentMethod: body.paymentMethod?.trim() || null,
            totalPaid: 0,
            itemCount: lineData.length,
            cleanerUserId,
            cleanerName,
            serviceStaffEmployeeId,
            locationCode,
            shippingStatus: body.shippingStatus ?? null,
            shippingAddress: body.shippingAddress?.trim() || null,
            trackingNumber: body.trackingNumber?.trim() || null,
            date: saleDate,
            lines: { create: lineData },
            ...createdBy,
          },
          include: {
            customer: true,
            job: { select: { reference: true } },
            serviceStaffEmployee: { select: { name: true } },
            lines: true,
          },
        });

        void this.invoiceHub
          .ensureSaleInvoice(this.tenantDb.db, row, row.lines)
          .catch((err: unknown) => {
            console.error('[sales] ensureSaleInvoice failed', err);
          });

        void this.auditService.log({
          action: 'created',
          entityType: 'sale',
          entityId: row.id,
          summary: `Recorded sale ${row.reference}`,
          metadata: {
            total: toNumber(row.total),
            paymentStatus: row.paymentStatus,
          },
        });

        this.refreshSaleSideEffects({
          customerId: row.customerId,
          listsOnly: true,
        });

        return this.toSaleDetail(row);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new BadRequestException(
            `Sale reference ${saleReference} already exists`,
          );
        }
        throw error;
      }
    }

    let row;
    try {
      row = await this.prisma.$transaction(
      async (tx) => {
      const stockDeltas = new Map<
        string,
        {
          itemTenantId: string;
          itemId: string;
          sku: string;
          locationCode: string | null | undefined;
          binLocation: string | null | undefined;
          delta: number;
        }
      >();
      const bumpStock = (
        key: string,
        entry: {
          itemTenantId: string;
          itemId: string;
          sku: string;
          locationCode?: string | null;
          binLocation?: string | null;
          delta: number;
        },
      ) => {
        const prev = stockDeltas.get(key);
        if (prev) {
          prev.delta += entry.delta;
          return;
        }
        stockDeltas.set(key, {
          itemTenantId: entry.itemTenantId,
          itemId: entry.itemId,
          sku: entry.sku,
          locationCode: entry.locationCode,
          binLocation: entry.binLocation,
          delta: entry.delta,
        });
      };

      if (!isProvisional && !skipStock) {
        const sellingTenant = await tx.tenant.findFirst({
          where: { id: tenantId, deletedAt: null },
          select: { code: true },
        });
        const sellingCode = sellingTenant?.code?.toUpperCase() ?? '';
        /** VA/VP: never gate on VW/VISP/VSP (or local) qty — outside sourcing is allowed. */
        const catalogOnlySeller = isGroupStockConsumerTenant(sellingCode);

        for (let index = 0; index < workingLines.length; index++) {
          const line = workingLines[index]!;
          const qty = Math.max(1, Math.round(line.quantity));
          const sourceCode = line.sourceTenantCode?.trim().toUpperCase();
          const isCrossSource =
            Boolean(sourceCode) &&
            sourceCode !== sellingCode &&
            !line.createPurchase &&
            Boolean(line.itemId);
          const needsPurchase =
            !isCrossSource &&
            (Boolean(line.createPurchase) || !line.itemId);
          if (!needsPurchase) continue;
          if (catalogOnlySeller) continue;

          const sku =
            line.sku?.trim() ||
            `ADHOC-${Date.now().toString(36).toUpperCase()}-${index + 1}`;
          let item = await tx.item.findFirst({
            where: { tenantId, sku, deletedAt: null },
          });
          if (!item) {
            item = await tx.item.create({
              data: {
                tenantId,
                sku,
                name: line.name.trim(),
                quantity: isOutsideOrServiceCatalogItem({
                  name: line.name,
                  sku,
                })
                  ? 0
                  : qty,
                costPrice: line.unitPrice,
                sellPrice: line.unitPrice,
                status: computeStockStatus(
                  isOutsideOrServiceCatalogItem({
                    name: line.name,
                    sku,
                  })
                    ? 0
                    : qty,
                  null,
                ),
                locationCode: locationCode ?? undefined,
              },
            });
          } else if (
            !isOutsideOrServiceCatalogItem({
              name: line.name || item.name,
              sku: item.sku ?? sku,
              category: item.category,
            })
          ) {
            const nextQty = toNumber(item.quantity) + qty;
            item = await tx.item.update({
              where: { id: item.id },
              data: {
                quantity: nextQty,
                status: computeStockStatus(nextQty, item.reorderPoint),
              },
            });
          }

          const purchaseLineTotal = qty * line.unitPrice;
          const purchaseLines = [
            {
              itemId: item.id,
              name: line.name,
              quantity: qty,
              unitCost: line.unitPrice,
              total: purchaseLineTotal,
            },
          ];
          const purchaseRollups = movementLineRollups(purchaseLines);
          let supplierId: string | null = line.supplierId?.trim() || null;
          if (supplierId) {
            const supplier = await tx.supplier.findFirst({
              where: { id: supplierId, tenantId, deletedAt: null },
              select: { id: true },
            });
            if (!supplier) supplierId = null;
          }
          await tx.stockMovement.create({
            data: {
              tenantId,
              type: 'inbound',
              reference: `${saleReference}-P${index + 1}`,
              status: 'Received',
              locationCode: locationCode ?? undefined,
              paymentStatus: 'due',
              supplierId,
              lines: purchaseLines,
              itemCount: purchaseRollups.itemCount,
              grandTotal: purchaseRollups.grandTotal,
              notes: `Ad-hoc purchase for sale ${saleReference}`,
              date: saleDate,
              ...createdBy,
            },
          });

          workingLines[index] = {
            ...line,
            itemId: item.id,
            sku,
            quantity: qty,
            sourceTenantCode: undefined,
          };
        }

        // Prefetch same-tenant items in one query (avoid N resolveActiveItem RTTs).
        const localItemIds = [
          ...new Set(
            workingLines
              .filter((line) => {
                if (!line.itemId) return false;
                const sourceCode = line.sourceTenantCode?.trim().toUpperCase();
                return !sourceCode || sourceCode === sellingCode;
              })
              .map((line) => line.itemId!.trim())
              .filter(Boolean),
          ),
        ];
        const localItemsById = new Map<
          string,
          Awaited<ReturnType<typeof resolveActiveItem>>
        >();
        if (localItemIds.length > 0 && !catalogOnlySeller) {
          const localRows = await tx.item.findMany({
            where: {
              tenantId,
              id: { in: localItemIds },
              deletedAt: null,
            },
          });
          for (const row of localRows) localItemsById.set(row.id, row);
        }

        for (const line of workingLines) {
          if (!line.itemId && !line.sourceTenantCode) continue;
          const qty = Math.max(1, Math.round(line.quantity));
          const sourceCode = line.sourceTenantCode?.trim().toUpperCase();
          const isCrossSource =
            Boolean(sourceCode) && sourceCode !== sellingCode;

          // VA/VP: price catalog only — never deduct stock (local or sister).
          if (catalogOnlySeller) continue;

          if (isCrossSource) {
            const sourceTenant = await tx.tenant.findFirst({
              where: { code: sourceCode!, deletedAt: null },
              select: { id: true, code: true },
            });
            if (!sourceTenant) {
              throw new BadRequestException(
                `Source entity ${sourceCode} not found for ${line.sku}`,
              );
            }
            const item = await resolveActiveItem(tx, {
              tenantId: sourceTenant.id,
              itemId: line.itemId,
              sku: line.sku,
            });
            if (!item) {
              throw new BadRequestException(
                `Item ${line.sku} not found at ${sourceCode}`,
              );
            }
            if (
              isOutsideOrServiceCatalogItem({
                name: line.name || item.name,
                sku: item.sku ?? line.sku,
                category: item.category,
              })
            ) {
              continue;
            }
            bumpStock(`${item.tenantId}:${item.id}`, {
              itemTenantId: item.tenantId,
              itemId: item.id,
              sku: line.sku,
              locationCode: item.locationCode,
              binLocation: item.binLocation,
              delta: -qty,
            });
            continue;
          }

          if (!line.itemId) continue;
          let item =
            localItemsById.get(line.itemId) ??
            (await resolveActiveItem(tx, {
              tenantId,
              itemId: line.itemId,
              sku: line.sku,
            }));
          if (!item) {
            throw new BadRequestException(`Item not found: ${line.sku}`);
          }
          if (
            isOutsideOrServiceCatalogItem({
              name: line.name || item.name,
              sku: item.sku ?? line.sku,
              category: item.category,
            })
          ) {
            continue;
          }
          if (item.id !== line.itemId) {
            line.itemId = item.id;
          }
          bumpStock(`${item.tenantId}:${item.id}`, {
            itemTenantId: item.tenantId,
            itemId: item.id,
            sku: line.sku,
            locationCode: locationCode ?? item.locationCode,
            binLocation: item.binLocation,
            delta: -qty,
          });
        }
      }

      if (!skipStock) {
        await this.applyItemStockDeltas(tx, stockDeltas);
      }

      const lineData = buildSaleLineRows(workingLines);
      const total = computeSaleTotal(lineData, orderDiscount, taxAmount);

      const resolvedPayments =
        !isProvisional && body.payments && body.payments.length > 0
          ? body.payments
          : [];
      const paidTotal = resolvedPayments.reduce((sum, row) => sum + row.amount, 0);
      let paymentStatus: PaymentStatus | null = isProvisional ? 'due' : 'paid';
      if (!isProvisional) {
        paymentStatus = paymentStatusFromAmounts(total, paidTotal);
      }

      const sale = await tx.sale.create({
        data: {
          tenantId,
          reference: saleReference,
          customerId,
          jobId,
          total,
          discountAmount: orderDiscount > 0 ? orderDiscount : null,
          taxAmount: taxAmount > 0 ? taxAmount : null,
          notes: body.notes?.trim() || null,
          currency,
          status,
          paymentStatus,
          paymentMethod:
            body.paymentMethod?.trim() ||
            resolvedPayments.find((p) => p.method?.trim())?.method?.trim() ||
            (resolvedPayments.length > 0 ? 'cash' : null),
          totalPaid: isProvisional ? 0 : paidTotal,
          itemCount: lineData.length,
          cleanerUserId,
          cleanerName,
          serviceStaffEmployeeId,
          locationCode,
          shippingStatus: body.shippingStatus ?? (isProvisional ? null : 'pending'),
          shippingAddress: body.shippingAddress?.trim() || null,
          trackingNumber: body.trackingNumber?.trim() || null,
          date: saleDate,
          lines: { create: lineData },
          ...createdBy,
        },
        include: {
          customer: true,
          job: { select: { reference: true } },
          serviceStaffEmployee: { select: { name: true } },
          lines: true,
        },
      });

      if (!skipStock) {
        await this.writeSaleOutboundMovement(tx, {
          tenantId,
          saleId: sale.id,
          saleReference: sale.reference,
          locationCode,
          date: saleDate,
          lines: this.outboundLinesFromStockDeltas(stockDeltas, workingLines),
          createdBy,
        });
      }

      const invoice = await this.invoiceHub.ensureSaleInvoice(
        tx,
        sale,
        sale.lines,
      );

      if (jobId && !isProvisional) {
        await tx.job.update({
          where: { id: jobId },
          data: {
            invoiceAmount: total,
            ...(customerId ? { customerId } : {}),
          },
        });
      }

      if (!isProvisional) {
        await tx.ledgerEntry.create({
          data: {
            tenantId,
            type: 'revenue',
            amount: total,
            currency,
            category: 'Sales',
            description: `Sale ${sale.reference}`,
            linkedRecordType: 'sale',
            linkedRecordId: sale.id,
            invoiceId: invoice.id,
            date: saleDate,
          },
        });

        for (const payment of resolvedPayments) {
          if (payment.amount <= 0) continue;
          const createdPayment = await tx.payment.create({
            data: {
              tenantId,
              amount: payment.amount,
              currency,
              method: payment.method ?? 'cash',
              paymentRefNo: `SP${saleDate.getFullYear()}/${sale.reference}`,
              paidOn: saleDate,
              paymentFor: 'sale',
              saleId: sale.id,
              invoiceId: invoice.id,
              accountId: payment.accountId ?? null,
              note: payment.note ?? null,
              createdByName: createdBy.createdByName ?? null,
            },
          });
          if (payment.accountId) {
            await recordPaymentAccountTxn(tx, {
              tenantId,
              accountId: payment.accountId,
              type: 'credit',
              subType: 'sale_payment',
              amount: payment.amount,
              operationDate: saleDate,
              refNo: createdPayment.paymentRefNo,
              note: payment.note ?? `Sale payment — ${sale.reference}`,
              paymentMethod: payment.method ?? 'cash',
              saleId: sale.id,
              paymentId: createdPayment.id,
              invoiceId: invoice.id,
              createdByName: createdBy.createdByName ?? null,
            });
          }
        }
      }

      return sale;
    },
      {
        /** Neon pooler + stock/purchase side-effects need more than the 5s default. */
        maxWait: 15_000,
        timeout: 60_000,
      },
    );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2028'
      ) {
        throw new BadRequestException(
          'Sale save timed out — please try again',
        );
      }
      throw error;
    }

    const saleTotal = toNumber(row.total);
    void this.auditService.log({
      action: 'created',
      entityType: 'sale',
      entityId: row.id,
      summary: `Recorded sale ${row.reference}`,
      metadata: { total: saleTotal, paymentStatus: row.paymentStatus },
    });

    this.refreshSaleSideEffects({
      customerId: row.customerId,
      ledgerEntry: !isProvisional
        ? {
            type: 'revenue',
            amount: saleTotal,
            date: row.date,
            currency,
          }
        : undefined,
    });

    return this.toSaleDetail(row);
  }

  /**
   * VA/VP workshop stage on the sale itself (sales act as jobs — no Job link required).
   * Stores stage + log in Sale.notes; syncs linked Job when present.
   */
  async updateJobWorkshopStatus(
    id: string,
    body: { status: string; notes?: string | null },
  ): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        lines: true,
        payments: { where: { deletedAt: null }, orderBy: { paidOn: 'asc' } },
        job: { select: { id: true, hasQuote: true, status: true } },
      },
    });
    if (!existing) throw new NotFoundException('Sale not found');

    let applied;
    try {
      applied = applySaleJobStatusNotes({
        notes: existing.notes,
        status: body.status,
        staffNote: body.notes,
        hasQuote: existing.job?.hasQuote ?? false,
      });
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Invalid job status',
      );
    }

    const row = await this.tenantDb.db.sale.update({
      where: { id },
      data: { notes: applied.notes },
      include: {
        customer: {
          select: {
            name: true,
            email: true,
            phone: true,
            totalSellDue: true,
          },
        },
        lines: true,
        payments: { where: { deletedAt: null }, orderBy: { paidOn: 'asc' } },
        job: { select: { id: true, reference: true } },
        serviceStaffEmployee: { select: { name: true } },
      },
    });

    if (existing.jobId) {
      try {
        const stamp = new Date()
          .toISOString()
          .slice(0, 16)
          .replace('T', ' ');
        const staffNote = body.notes?.trim();
        await this.tenantDb.db.job.update({
          where: { id: existing.jobId },
          data: {
            status: applied.status,
            ...(staffNote
              ? {
                  qcNotes: `[${stamp}] Status → ${applied.status}: ${staffNote}`,
                }
              : {}),
          },
        });
      } catch {
        // Sale notes are source of truth when job sync fails.
      }
    }

    await this.auditService.log({
      action: 'updated',
      entityType: 'sale',
      entityId: id,
      summary: `Workshop status → ${applied.status}`,
      metadata: {
        status: applied.status,
        notesAdded: Boolean(body.notes?.trim()),
      },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return this.toSaleDetail(row);
  }

  /** In-place sale edit — same id; sync invoice; net stock; keep existing payments. */
  async update(
    id: string,
    body: {
      reference?: string;
      customerName?: string;
      customerId?: string;
      jobId?: string;
      locationCode?: string;
      paymentMethod?: string;
      cleanerUserId?: string;
      cleanerName?: string;
      serviceStaffEmployeeId?: string;
      lines: SaleLineInput[];
      currency?: string;
      date?: string;
      status?: SaleStatus | 'final';
      shippingStatus?: string;
      shippingAddress?: string;
      trackingNumber?: string;
      discountAmount?: number;
      taxAmount?: number;
      notes?: string;
      payments?: Array<{
        amount: number;
        method?: string;
        note?: string;
        accountId?: string;
      }>;
    },
  ): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const [existing, createdBy] = await Promise.all([
      this.tenantDb.db.sale.findFirst({
        where: { id, tenantId, deletedAt: null },
        include: {
          customer: true,
          lines: true,
          payments: { where: { deletedAt: null }, select: { id: true, amount: true } },
        },
      }),
      this.auditService.createdByFields(),
    ]);
    if (!existing) throw new NotFoundException('Sale not found');

    let locationCode = await this.tenantDb.resolveBusinessLocation(
      body.locationCode ?? existing.locationCode ?? undefined,
    );
    const currency = body.currency ?? existing.currency ?? 'NGN';
    const saleDate = body.date ? new Date(body.date) : existing.date;
    const status = normalizeCreateStatus(body.status ?? existing.status);
    const isProvisional = isProvisionalSaleStatus(status);
    const wasFinalized = !isProvisionalSaleStatus(existing.status);
    // Paid / final sales may be demoted back to quotation or draft (stock +
    // ledger + payments are reversed below).
    const becomingFinal = !isProvisional && !wasFinalized;
    const stayingOrBecomingFinal = !isProvisional;

    let jobId: string | null =
      body.jobId !== undefined ? body.jobId.trim() || null : existing.jobId;

    let serviceStaffEmployeeId: string | null =
      existing.serviceStaffEmployeeId;
    let cleanerUserId =
      body.cleanerUserId !== undefined
        ? body.cleanerUserId?.trim() || null
        : existing.cleanerUserId;
    let cleanerName =
      body.cleanerName !== undefined
        ? body.cleanerName?.trim() || null
        : existing.cleanerName;

    const customerIdInput = body.customerId?.trim();
    const customerNameInput = body.customerName?.trim();
    const employeeIdInput = body.serviceStaffEmployeeId?.trim();

    // Parallelize independent lookups (was 3–6 sequential Neon RTTs).
    const [jobRow, employeeRow, customerById, customerByName] =
      await Promise.all([
        jobId
          ? this.tenantDb.db.job.findFirst({
              where: { id: jobId, tenantId, deletedAt: null },
              select: { id: true, reference: true, locationCode: true },
            })
          : Promise.resolve(null),
        employeeIdInput
          ? this.tenantDb.db.employee.findFirst({
              where: { id: employeeIdInput, tenantId, deletedAt: null },
              select: { id: true, name: true, userId: true },
            })
          : Promise.resolve(null),
        customerIdInput
          ? this.tenantDb.db.customer.findFirst({
              where: { id: customerIdInput, tenantId, deletedAt: null },
            })
          : Promise.resolve(null),
        !customerIdInput && customerNameInput
          ? this.tenantDb.db.customer.findFirst({
              where: {
                tenantId,
                deletedAt: null,
                name: { equals: customerNameInput, mode: 'insensitive' },
              },
            })
          : Promise.resolve(null),
      ]);

    if (jobId) {
      if (!jobRow) throw new BadRequestException('Job not found');
      const existingForJob = await this.tenantDb.db.sale.findFirst({
        where: {
          tenantId,
          jobId,
          deletedAt: null,
          id: { not: id },
        },
        select: { id: true, reference: true },
      });
      if (existingForJob) {
        throw new BadRequestException(
          `Job ${jobRow.reference} already has sale ${existingForJob.reference}`,
        );
      }
      if (!locationCode && jobRow.locationCode) locationCode = jobRow.locationCode;
    }

    if (employeeIdInput) {
      if (!employeeRow) {
        throw new BadRequestException('Service staff employee not found');
      }
      serviceStaffEmployeeId = employeeRow.id;
      cleanerName = cleanerName || employeeRow.name;
      cleanerUserId = cleanerUserId || employeeRow.userId;
    }

    let customerId: string | null = existing.customerId;
    if (customerIdInput) {
      if (!customerById) throw new BadRequestException('Customer not found');
      customerId = customerById.id;
    } else if (customerNameInput) {
      if (customerByName) customerId = customerByName.id;
      else {
        const created = await this.tenantDb.db.customer.create({
          data: { tenantId, name: customerNameInput, ...createdBy },
        });
        customerId = created.id;
      }
    }

    const workingLines: SaleLineInput[] = body.lines.map((line) => ({
      ...line,
    }));
    if (workingLines.length === 0) {
      throw new BadRequestException('Add at least one line item');
    }

    const orderDiscount = body.discountAmount ?? toNumber(existing.discountAmount ?? 0);
    const taxAmount = body.taxAmount ?? toNumber(existing.taxAmount ?? 0);
    const sellingTenantForStock = await this.tenantDb.db.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { code: true },
    });
    // VA/VP: never deduct/validate stock (local or VW/VISP/VSP); outside sourcing OK.
    const skipStock =
      Boolean(jobId) ||
      isGroupStockConsumerTenant(sellingTenantForStock?.code);
    const saleReference = body.reference?.trim() || existing.reference;

    const priorPaid = existing.payments.reduce(
      (sum, p) => sum + toNumber(p.amount),
      0,
    );

    const row = await this.prisma.$transaction(
      async (tx) => {
        const stockDeltas = new Map<
          string,
          {
            itemTenantId: string;
            itemId: string;
            sku: string;
            locationCode: string | null | undefined;
            binLocation: string | null | undefined;
            delta: number;
          }
        >();
        const bumpStock = (
          key: string,
          entry: {
            itemTenantId: string;
            itemId: string;
            sku: string;
            locationCode?: string | null;
            binLocation?: string | null;
            delta: number;
          },
        ) => {
          const prev = stockDeltas.get(key);
          if (prev) {
            prev.delta += entry.delta;
            return;
          }
          stockDeltas.set(key, {
            itemTenantId: entry.itemTenantId,
            itemId: entry.itemId,
            sku: entry.sku,
            locationCode: entry.locationCode,
            binLocation: entry.binLocation,
            delta: entry.delta,
          });
        };

        const sellingTenant = await tx.tenant.findFirst({
          where: { id: tenantId, deletedAt: null },
          select: { code: true },
        });
        const sellingCode = sellingTenant?.code?.toUpperCase() ?? '';
        const catalogOnlySeller = isGroupStockConsumerTenant(sellingCode);

        const applyLineStock = async (
          line: {
            itemId: string | null;
            sku: string;
            quantity: { toString(): string } | number;
            sourceTenantCode: string | null;
          },
          sign: 1 | -1,
        ) => {
          if (!line.itemId) return;
          const qty = toNumber(line.quantity);
          if (qty <= 0) return;
          const sourceCode = line.sourceTenantCode?.trim().toUpperCase();
          const isCrossSource =
            Boolean(sourceCode) && sourceCode !== sellingCode;
          // VA/VP: never deduct local or cross-entity stock on catalog billing.
          if (catalogOnlySeller) return;
          let itemTenantId = tenantId;
          if (isCrossSource) {
            const sourceTenant = await tx.tenant.findFirst({
              where: { code: sourceCode!, deletedAt: null },
              select: { id: true },
            });
            if (!sourceTenant) return;
            itemTenantId = sourceTenant.id;
          }
          const item = await resolveActiveItem(tx, {
            tenantId: itemTenantId,
            itemId: line.itemId,
            sku: line.sku,
          });
          if (!item) return;
          if (
            isOutsideOrServiceCatalogItem({
              name: item.name,
              sku: item.sku ?? line.sku,
              category: item.category,
            })
          ) {
            return;
          }
          bumpStock(`${item.tenantId}:${item.id}`, {
            itemTenantId: item.tenantId,
            itemId: item.id,
            sku: line.sku,
            locationCode: locationCode ?? item.locationCode,
            binLocation: item.binLocation,
            delta: sign * qty,
          });
        };

        if (!skipStock) {
          // Restore prior finalized deductions, then apply new if finalized.
          if (wasFinalized) {
            for (const line of existing.lines) {
              await applyLineStock(line, 1);
            }
          }
          if (stayingOrBecomingFinal) {
            for (const line of workingLines) {
              if (!line.itemId) continue;
              await applyLineStock(
                {
                  itemId: line.itemId,
                  sku: line.sku,
                  quantity: line.quantity,
                  sourceTenantCode: line.sourceTenantCode?.trim() || null,
                },
                -1,
              );
            }
          }
          await this.applyItemStockDeltas(tx, stockDeltas);
          await this.softDeleteSaleOutboundMovements(tx, tenantId, id);
          if (stayingOrBecomingFinal) {
            await this.writeSaleOutboundMovement(tx, {
              tenantId,
              saleId: id,
              saleReference,
              locationCode,
              date: saleDate,
              lines: this.outboundLinesFromSaleLines(workingLines),
              createdBy,
            });
          }
        }

        const lineData = buildSaleLineRows(workingLines);
        const total = computeSaleTotal(lineData, orderDiscount, taxAmount);

        let paidTotal = priorPaid;
        let paymentStatus: PaymentStatus | null = existing.paymentStatus;
        if (isProvisional) {
          paidTotal = 0;
          paymentStatus = 'due';
        } else if (becomingFinal) {
          // Quotation/draft → final: only count payments that have an account.
          // No payment account attached → due (collect later).
          if (body.payments && body.payments.length > 0) {
            paidTotal = body.payments
              .filter((p) => Boolean(p.accountId?.trim()) && p.amount > 0)
              .reduce((sum, p) => sum + p.amount, 0);
          } else {
            paidTotal = 0;
          }
          paymentStatus = paymentStatusFromAmounts(total, paidTotal);
        } else {
          paymentStatus = paymentStatusFromAmounts(total, paidTotal, existing.paymentStatus);
        }

        await tx.saleLine.deleteMany({ where: { saleId: id } });

        const updated = await tx.sale.update({
          where: { id },
          data: {
            reference: saleReference,
            customerId,
            jobId,
            total,
            discountAmount: orderDiscount > 0 ? orderDiscount : null,
            taxAmount: taxAmount > 0 ? taxAmount : null,
            notes: body.notes !== undefined ? body.notes?.trim() || null : existing.notes,
            currency,
            status,
            paymentStatus,
            paymentMethod:
              body.paymentMethod !== undefined
                ? body.paymentMethod?.trim() || null
                : body.payments?.find((p) => p.method?.trim())?.method?.trim() ||
                  existing.paymentMethod,
            totalPaid: isProvisional ? 0 : paidTotal,
            itemCount: lineData.length,
            cleanerUserId,
            cleanerName,
            serviceStaffEmployeeId,
            locationCode,
            shippingStatus:
              body.shippingStatus ??
              existing.shippingStatus ??
              (isProvisional ? null : 'pending'),
            shippingAddress:
              body.shippingAddress !== undefined
                ? body.shippingAddress?.trim() || null
                : existing.shippingAddress,
            trackingNumber:
              body.trackingNumber !== undefined
                ? body.trackingNumber?.trim() || null
                : existing.trackingNumber,
            date: saleDate,
            lines: { create: lineData },
          },
          include: {
            customer: true,
            job: { select: { reference: true } },
            serviceStaffEmployee: { select: { name: true } },
            lines: true,
          },
        });

        const invoice = await this.invoiceHub.ensureSaleInvoice(
          tx,
          updated,
          updated.lines,
        );

        if (jobId && !isProvisional) {
          await tx.job.update({
            where: { id: jobId },
            data: {
              invoiceAmount: total,
              ...(customerId ? { customerId } : {}),
            },
          });
        }

        // Ledger: create when newly finalized; update amount when already final; soft-delete if demoted.
        if (wasFinalized && isProvisional) {
          await tx.ledgerEntry.updateMany({
            where: {
              tenantId,
              linkedRecordType: 'sale',
              linkedRecordId: id,
              deletedAt: null,
            },
            data: { deletedAt: new Date() },
          });
          const priorPayments = await tx.payment.findMany({
            where: { tenantId, saleId: id, deletedAt: null },
            select: { id: true },
          });
          for (const payment of priorPayments) {
            await softDeletePaymentAccountTxns(tx, {
              tenantId,
              paymentId: payment.id,
            });
          }
          await tx.payment.updateMany({
            where: { tenantId, saleId: id, deletedAt: null },
            data: { deletedAt: new Date() },
          });
          await tx.accountTransaction.updateMany({
            where: { tenantId, saleId: id, deletedAt: null },
            data: { deletedAt: new Date() },
          });
        } else if (becomingFinal) {
          await tx.ledgerEntry.create({
            data: {
              tenantId,
              type: 'revenue',
              amount: total,
              currency,
              category: 'Sales',
              description: `Sale ${updated.reference}`,
              linkedRecordType: 'sale',
              linkedRecordId: id,
              invoiceId: invoice.id,
              date: saleDate,
            },
          });
        } else if (wasFinalized && stayingOrBecomingFinal) {
          await tx.ledgerEntry.updateMany({
            where: {
              tenantId,
              linkedRecordType: 'sale',
              linkedRecordId: id,
              deletedAt: null,
            },
            data: {
              amount: total,
              date: saleDate,
              description: `Sale ${updated.reference}`,
              invoiceId: invoice.id,
            },
          });
        }

        if (becomingFinal && body.payments) {
          for (const payment of body.payments) {
            if (payment.amount <= 0) continue;
            // Convert without a payment account → no payment row (sale stays due).
            if (!payment.accountId?.trim()) continue;
            const createdPayment = await tx.payment.create({
              data: {
                tenantId,
                amount: payment.amount,
                currency,
                method: payment.method ?? 'cash',
                paymentRefNo: `SP${saleDate.getFullYear()}/${updated.reference}`,
                paidOn: saleDate,
                paymentFor: 'sale',
                saleId: id,
                invoiceId: invoice.id,
                accountId: payment.accountId,
                note: payment.note ?? null,
                createdByName: createdBy.createdByName ?? null,
              },
            });
            await recordPaymentAccountTxn(tx, {
              tenantId,
              accountId: payment.accountId,
              type: 'credit',
              subType: 'sale_payment',
              amount: payment.amount,
              operationDate: saleDate,
              refNo: createdPayment.paymentRefNo,
              note: payment.note ?? `Sale payment — ${updated.reference}`,
              paymentMethod: payment.method ?? 'cash',
              saleId: id,
              paymentId: createdPayment.id,
              invoiceId: invoice.id,
              createdByName: createdBy.createdByName ?? null,
            });
          }
          const newPaid = (
            await tx.payment.findMany({
              where: { tenantId, saleId: id, deletedAt: null },
              select: { amount: true },
            })
          ).reduce((sum, p) => sum + toNumber(p.amount), 0);
          await tx.sale.update({
            where: { id },
            data: {
              totalPaid: newPaid,
              paymentStatus: paymentStatusFromAmounts(total, newPaid),
            },
          });
        }

        return tx.sale.findFirstOrThrow({
          where: { id },
          include: {
            customer: true,
            job: { select: { reference: true } },
            serviceStaffEmployee: { select: { name: true } },
            lines: true,
          },
        });
      },
      { maxWait: 15_000, timeout: 60_000 },
    );

    const saleTotal = toNumber(row.total);
    const prevPayment = existing.paymentStatus ?? 'due';
    const nextPayment = row.paymentStatus ?? prevPayment;
    const prevStatus = existing.status ?? null;
    const nextStatus = row.status ?? prevStatus;
    void this.auditService.log({
      action: 'updated',
      entityType: 'sale',
      entityId: row.id,
      summary: `Updated sale ${row.reference}`,
      metadata: {
        total: saleTotal,
        paymentStatus: nextPayment,
        ...(prevPayment !== nextPayment
          ? { from: prevPayment, to: nextPayment }
          : prevStatus !== nextStatus && prevStatus && nextStatus
            ? { from: prevStatus, to: nextStatus }
            : {}),
      },
    });

    if (wasFinalized && saleTotal !== toNumber(existing.total)) {
      const delta = saleTotal - toNumber(existing.total);
      if (delta !== 0) {
        void applyDailyFinanceDelta(
          this.prisma,
          tenantId,
          row.date,
          'revenue',
          delta,
          currency,
        );
      }
    } else if (becomingFinal && saleTotal > 0) {
      void applyDailyFinanceDelta(
        this.prisma,
        tenantId,
        row.date,
        'revenue',
        saleTotal,
        currency,
      );
    } else if (wasFinalized && isProvisional) {
      void applyDailyFinanceDelta(
        this.prisma,
        tenantId,
        existing.date,
        'revenue',
        -Math.abs(toNumber(existing.total)),
        existing.currency ?? 'NGN',
      );
    }

    this.refreshSaleSideEffects({
      customerId: row.customerId,
      ledgerEntry: undefined,
    });
    if (existing.customerId && existing.customerId !== row.customerId) {
      void refreshCustomerFinancialRollups(this.tenantDb.db, existing.customerId);
    }

    return this.toSaleDetail(row);
  }

  /** Convert a draft or quotation into a completed sale (stock + ledger + payments). */
  async finalize(
    id: string,
    body: {
      payments?: Array<{
        amount: number;
        method?: string;
        note?: string;
        accountId?: string;
      }>;
    } = {},
  ): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { customer: true, lines: true },
    });
    if (!existing) throw new NotFoundException('Sale not found');
    if (existing.status !== 'draft' && existing.status !== 'quotation') {
      throw new BadRequestException('Only drafts and quotations can be finalized');
    }

    const total = toNumber(existing.total);
    // Convert without a payment account → due. Only count payments that have an account.
    const paymentRows = (body.payments ?? []).filter(
      (row) => Boolean(row.accountId?.trim()) && row.amount > 0,
    );
    const paidTotal = paymentRows.reduce((sum, row) => sum + row.amount, 0);
    const paymentStatus = paymentStatusFromAmounts(total, paidTotal);

    const createdBy = {
      createdByUserId: existing.createdByUserId ?? null,
      createdByName: existing.createdByName ?? null,
    };

    const row = await this.prisma.$transaction(
      async (tx) => {
      const sellingTenant = await tx.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { code: true },
      });
      const sellingCode = sellingTenant?.code?.toUpperCase() ?? '';
      const catalogOnlySeller = isGroupStockConsumerTenant(sellingCode);
      const outboundLines: Array<{
        itemId: string;
        sku: string;
        name: string;
        quantity: number;
        unitCost: number;
      }> = [];

      // VA/VP: never touch stock on finalize — catalog billing; outside sourcing OK.
      if (!existing.jobId && !catalogOnlySeller) {
        for (const line of existing.lines) {
          if (!line.itemId) continue;
          const qty = toNumber(line.quantity);
          if (qty <= 0) continue;

          const sourceCode = line.sourceTenantCode?.trim().toUpperCase();
          const isCrossSource =
            Boolean(sourceCode) && sourceCode !== sellingCode;

          const itemTenantId = isCrossSource
            ? (
                await tx.tenant.findFirst({
                  where: { code: sourceCode!, deletedAt: null },
                  select: { id: true },
                })
              )?.id
            : tenantId;
          if (!itemTenantId) {
            throw new BadRequestException(
              `Source entity ${sourceCode} not found for ${line.sku}`,
            );
          }

          const item = await resolveActiveItem(tx, {
            tenantId: itemTenantId,
            itemId: line.itemId,
            sku: line.sku,
          });
          if (!item) {
            // Catalog row soft-deleted with no live SKU twin — don't block
            // convert/pay on historical quotations; skip stock for this line.
            this.logger.warn(
              `Finalize ${existing.reference}: skip stock for missing item ${line.sku} (${line.itemId})`,
            );
            continue;
          }
          if (
            isOutsideOrServiceCatalogItem({
              name: line.name || item.name,
              sku: item.sku ?? line.sku,
              category: item.category,
            })
          ) {
            continue;
          }
          if (!isCrossSource && item.id !== line.itemId) {
            await tx.saleLine.update({
              where: { id: line.id },
              data: { itemId: item.id },
            });
          }
          const headerQty = toNumber(item.quantity);
          const currentQty = await effectiveItemOnHand(tx, item.id, headerQty);
          const nextQuantity = currentQty - qty;
          if (nextQuantity < 0) {
            throw new BadRequestException(
              `Insufficient stock at ${sourceCode ?? sellingCode} for ${line.sku} (need ${qty}, have ${currentQty})`,
            );
          }
          await tx.item.update({
            where: { id: item.id },
            data: {
              quantity: nextQuantity,
              status: computeStockStatus(nextQuantity, item.reorderPoint),
            },
          });
          await adjustItemLocationStock(tx, {
            tenantId: item.tenantId,
            itemId: item.id,
            locationCode: existing.locationCode ?? item.locationCode,
            binLocation: item.binLocation,
            delta: -qty,
          });
          outboundLines.push({
            itemId: item.id,
            sku: line.sku,
            name: line.name || item.name,
            quantity: qty,
            unitCost: toNumber(line.unitPrice),
          });
        }
      }

      const sale = await tx.sale.update({
        where: { id },
        data: {
          status: 'completed',
          paymentStatus,
          totalPaid: paidTotal,
          paymentMethod:
            paymentRows.find((p) => p.method?.trim())?.method?.trim() ||
            existing.paymentMethod ||
            null,
          shippingStatus: existing.shippingStatus ?? 'pending',
        },
        include: {
          customer: true,
          job: { select: { reference: true } },
          lines: true,
        },
      });

      if (existing.jobId) {
        await tx.job.update({
          where: { id: existing.jobId },
          data: { invoiceAmount: total },
        });
      }

      if (!existing.jobId && !catalogOnlySeller) {
        await this.writeSaleOutboundMovement(tx, {
          tenantId,
          saleId: id,
          saleReference: sale.reference,
          locationCode: existing.locationCode,
          date: existing.date,
          lines: outboundLines,
          createdBy,
        });
      }

      await tx.ledgerEntry.create({
        data: {
          tenantId,
          type: 'revenue',
          amount: total,
          currency: existing.currency,
          category: 'Sales',
          description: `Sale ${sale.reference}`,
          linkedRecordType: 'sale',
          linkedRecordId: sale.id,
          date: existing.date,
        },
      });

      for (const payment of paymentRows) {
        if (payment.amount <= 0) continue;
        const createdPayment = await tx.payment.create({
          data: {
            tenantId,
            amount: payment.amount,
            currency: existing.currency,
            method: payment.method ?? 'cash',
            paymentRefNo: `SP${existing.date.getFullYear()}/${sale.reference}`,
            paidOn: existing.date,
            paymentFor: 'sale',
            saleId: sale.id,
            accountId: payment.accountId ?? null,
            note: payment.note ?? null,
            createdByName: existing.createdByName ?? null,
          },
        });
        if (payment.accountId) {
          await recordPaymentAccountTxn(tx, {
            tenantId,
            accountId: payment.accountId,
            type: 'credit',
            subType: 'sale_payment',
            amount: payment.amount,
            operationDate: existing.date,
            refNo: createdPayment.paymentRefNo,
            note: payment.note ?? `Sale payment — ${sale.reference}`,
            paymentMethod: payment.method ?? 'cash',
            saleId: sale.id,
            paymentId: createdPayment.id,
            createdByName: existing.createdByName ?? null,
          });
        }
      }

      return sale;
    },
      {
        maxWait: 15_000,
        timeout: 60_000,
      },
    );

    await this.auditService.log({
      action: 'updated',
      entityType: 'sale',
      entityId: id,
      summary: `Finalized sale ${row.reference}`,
      metadata: {
        paymentStatus,
        from: existing.status ?? 'draft',
        to: 'completed',
        fromPaymentStatus: existing.paymentStatus ?? 'due',
        toPaymentStatus: paymentStatus,
      },
    });

    this.refreshSaleSideEffects({
      customerId: row.customerId,
      ledgerEntry: {
        type: 'revenue',
        amount: toNumber(row.total),
        date: row.date,
        currency: row.currency,
      },
    });

    return this.toSaleDetail(row);
  }

  /** Record a return against a completed sale (refund, restock, or write-off). */
  async createReturn(
    id: string,
    body: {
      disposition: 'refunded' | 'restocked' | 'written_off';
      notes?: string;
      lines?: Array<{ saleLineId: string; quantity: number }>;
    },
  ): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const createdBy = await this.auditService.createdByFields();
    const original = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { customer: true, lines: true },
    });
    if (!original) throw new NotFoundException('Sale not found');
    if (original.status !== 'completed') {
      throw new BadRequestException('Only completed sales can be returned');
    }
    if (original.originalSaleId) {
      throw new BadRequestException('Returns cannot be created from another return');
    }

    const existingReturn = await this.tenantDb.db.sale.findFirst({
      where: {
        tenantId,
        originalSaleId: id,
        deletedAt: null,
        status: { in: ['refunded', 'partially_refunded', 'written_off'] },
      },
    });
    if (existingReturn) {
      throw new BadRequestException('A return already exists for this sale');
    }

    const returnStatus: SaleStatus =
      body.disposition === 'restocked'
        ? 'partially_refunded'
        : body.disposition === 'written_off'
          ? 'written_off'
          : 'refunded';

    const lineById = new Map(original.lines.map((line) => [line.id, line]));
    const requestedLines =
      body.lines && body.lines.length > 0
        ? body.lines
        : original.lines.map((line) => ({
            saleLineId: line.id,
            quantity: toNumber(line.quantity),
          }));

    const returnLineRows: SaleLineInput[] = [];
    let returnTotal = 0;
    for (const req of requestedLines) {
      const source = lineById.get(req.saleLineId);
      if (!source) {
        throw new BadRequestException(`Unknown sale line: ${req.saleLineId}`);
      }
      const maxQty = toNumber(source.quantity);
      if (!Number.isFinite(req.quantity) || req.quantity <= 0) {
        throw new BadRequestException('Return quantity must be positive');
      }
      if (req.quantity > maxQty) {
        throw new BadRequestException(
          `Return quantity exceeds sold quantity for ${source.sku}`,
        );
      }
      const unitPrice = toNumber(source.unitPrice);
      const lineTotal = unitPrice * req.quantity;
      returnTotal += lineTotal;
      returnLineRows.push({
        itemId: source.itemId ?? undefined,
        sku: source.sku,
        name: source.name,
        quantity: req.quantity,
        unitPrice,
        discountAmount: source.discountAmount
          ? toNumber(source.discountAmount)
          : undefined,
      });
    }

    if (returnLineRows.length === 0) {
      throw new BadRequestException('No lines to return');
    }

    const isFullReturn =
      requestedLines.length === original.lines.length &&
      requestedLines.every((req) => {
        const source = lineById.get(req.saleLineId);
        return source && req.quantity === toNumber(source.quantity);
      });
    if (isFullReturn) {
      returnTotal = toNumber(original.total);
    }

    let reference = `RET-${original.reference}`;
    let suffix = 1;
    while (
      await this.tenantDb.db.sale.findFirst({
        where: { tenantId, reference, deletedAt: null },
      })
    ) {
      reference = `RET-${original.reference}-${suffix}`;
      suffix += 1;
    }

    const saleDate = new Date();
    const lineData = buildSaleLineRows(returnLineRows);
    const notes = body.notes?.trim() || null;

    const row = await this.prisma.$transaction(
      async (tx) => {
      if (body.disposition === 'restocked') {
        for (const line of returnLineRows) {
          if (!line.itemId) continue;
          const item = await resolveActiveItem(tx, {
            tenantId,
            itemId: line.itemId,
            sku: line.sku,
          });
          if (!item) {
            this.logger.warn(
              `Return ${reference}: skip restock for missing item ${line.sku} (${line.itemId})`,
            );
            continue;
          }
          const currentQty = toNumber(item.quantity);
          const nextQuantity = currentQty + line.quantity;
          await tx.item.update({
            where: { id: item.id },
            data: {
              quantity: nextQuantity,
              status: computeStockStatus(nextQuantity, item.reorderPoint),
            },
          });
          await adjustItemLocationStock(tx, {
            tenantId,
            itemId: item.id,
            locationCode: original.locationCode ?? item.locationCode,
            binLocation: item.binLocation,
            delta: line.quantity,
          });
        }
      }

      const sale = await tx.sale.create({
        data: {
          tenantId,
          reference,
          originalSaleId: original.id,
          customerId: original.customerId,
          total: returnTotal,
          currency: original.currency,
          status: returnStatus,
          paymentStatus: 'paid',
          totalPaid: returnTotal,
          itemCount: lineData.length,
          locationCode: original.locationCode,
          notes,
          date: saleDate,
          lines: { create: lineData },
          ...createdBy,
        },
        include: {
          customer: true,
          lines: true,
          originalSale: { select: { reference: true } },
        },
      });

      const invoice = await this.invoiceHub.ensureSaleInvoice(
        tx,
        sale,
        sale.lines,
      );

      await tx.ledgerEntry.create({
        data: {
          tenantId,
          type: 'expense',
          amount: returnTotal,
          currency: original.currency,
          category: 'Sales Returns',
          description: `Return ${sale.reference} for sale ${original.reference}`,
          linkedRecordType: 'sale',
          linkedRecordId: sale.id,
          invoiceId: invoice.id,
          date: saleDate,
        },
      });

      return sale;
    },
      {
        maxWait: 15_000,
        timeout: 60_000,
      },
    );

    await this.auditService.log({
      action: 'created',
      entityType: 'sale',
      entityId: row.id,
      summary: `Recorded return ${row.reference} for sale ${original.reference}`,
      metadata: { disposition: body.disposition, total: returnTotal },
    });

    this.refreshSaleSideEffects({
      customerId: row.customerId,
      ledgerEntry: {
        type: 'expense',
        amount: returnTotal,
        date: row.date,
        currency: row.currency,
      },
    });

    return this.toSaleDetail(row);
  }

  async updateShipping(
    id: string,
    body: {
      shippingStatus?: string | null;
      shippingAddress?: string | null;
      trackingNumber?: string | null;
    },
  ): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Sale not found');

    const row = await this.tenantDb.db.sale.update({
      where: { id },
      data: {
        shippingStatus: body.shippingStatus ?? undefined,
        shippingAddress: body.shippingAddress ?? undefined,
        trackingNumber: body.trackingNumber ?? undefined,
      },
      include: { customer: true, lines: true },
    });

    return this.toSaleDetail(row);
  }

  /** Soft-delete a sale (HQ6 list “Delete” → Are you sure?). */
  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        id: true,
        reference: true,
        customerId: true,
        jobId: true,
        status: true,
        total: true,
        currency: true,
        date: true,
        locationCode: true,
        lines: {
          select: {
            itemId: true,
            sku: true,
            quantity: true,
            sourceTenantCode: true,
          },
        },
        payments: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });
    if (!existing) throw new NotFoundException('Sale not found');

    const wasFinalized = existing.status === 'completed';
    const saleTotal = toNumber(existing.total);

    await this.prisma.$transaction(async (tx) => {
      // Restore stock for finalized sales (drafts/quotations never deducted).
      if (wasFinalized) {
        for (const line of existing.lines) {
          if (!line.itemId) continue;
          const qty = toNumber(line.quantity);
          if (qty <= 0) continue;

          let itemTenantId = tenantId;
          if (line.sourceTenantCode) {
            const sourceTenant = await tx.tenant.findFirst({
              where: {
                code: line.sourceTenantCode,
                deletedAt: null,
              },
              select: { id: true },
            });
            if (sourceTenant) itemTenantId = sourceTenant.id;
          }

          const item = await tx.item.findFirst({
            where: {
              id: line.itemId,
              tenantId: itemTenantId,
              deletedAt: null,
            },
          });
          if (!item) continue;

          const nextQuantity = toNumber(item.quantity) + qty;
          await tx.item.update({
            where: { id: item.id },
            data: {
              quantity: nextQuantity,
              status: computeStockStatus(nextQuantity, item.reorderPoint),
            },
          });
          await adjustItemLocationStock(tx, {
            tenantId: itemTenantId,
            itemId: item.id,
            locationCode: item.locationCode ?? existing.locationCode,
            binLocation: item.binLocation,
            delta: qty,
          });
        }
      }

      await this.softDeleteSaleOutboundMovements(tx, tenantId, id);

      for (const payment of existing.payments) {
        await softDeletePaymentAccountTxns(tx, {
          tenantId,
          paymentId: payment.id,
        });
      }

      await tx.payment.updateMany({
        where: { tenantId, saleId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      await tx.accountTransaction.updateMany({
        where: { tenantId, saleId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      await tx.ledgerEntry.updateMany({
        where: {
          tenantId,
          linkedRecordType: 'sale',
          linkedRecordId: id,
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });

      await tx.invoice.updateMany({
        where: { tenantId, saleId: id, deletedAt: null },
        // Prisma uniqueness is enforced on (tenantId, reference, kind) and
        // (tenantId, jobId, kind). Soft-deleting invoices without rewriting
        // those fields can block re-sell / re-invoice with the same
        // reference/job.
        data: {
          deletedAt: new Date(),
          reference: `${existing.reference}__del_${id.slice(-8)}`,
          jobId: null,
        },
      });

      // Free unique (tenantId, jobId) / reference so re-sell / re-invoice works.
      await tx.sale.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          jobId: null,
          reference: `${existing.reference}__del_${id.slice(-8)}`,
        },
      });
    });

    if (wasFinalized && saleTotal > 0) {
      void applyDailyFinanceDelta(
        this.prisma,
        tenantId,
        existing.date,
        'revenue',
        -Math.abs(saleTotal),
        existing.currency ?? 'NGN',
      );
    }

    if (existing.customerId) {
      await refreshCustomerFinancialRollups(
        this.tenantDb.db,
        existing.customerId,
      );
    }

    void invalidateTenantDashboardCache(this.cache, tenantId);
    await this.auditService.log({
      action: 'deleted',
      entityType: 'sale',
      entityId: id,
      summary: `Deleted sale ${existing.reference}`,
    });
  }

  async listPayments(id: string): Promise<
    Array<{
      id: string;
      amount: number;
      currency: string;
      method: string | null;
      paymentRefNo: string | null;
      paidOn: string | null;
      note: string | null;
      accountId: string | null;
      accountName: string | null;
      createdByName: string | null;
    }>
  > {
    const tenantId = this.tenantDb.requireTenantId();
    const sale = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!sale) throw new NotFoundException('Sale not found');

    const rows = await this.listSalePaymentRows(id, tenantId);

    return rows.map((row) => ({
      id: row.id,
      amount: toNumber(row.amount),
      currency: row.currency,
      method: row.method,
      paymentRefNo: row.paymentRefNo,
      paidOn: row.paidOn ? toIso(row.paidOn) : null,
      note: row.note,
      accountId: row.accountId,
      accountName: row.account?.name ?? null,
      createdByName: row.createdByName,
    }));
  }

  /**
   * Payments for a sale: direct saleId link and/or invoice-linked rows.
   * Shared by invoice View (`getView`) and View Payments (`listPayments`).
   */
  private async listSalePaymentRows(saleId: string, tenantId: string) {
    const invoice = await this.tenantDb.db.invoice.findFirst({
      where: { tenantId, saleId, deletedAt: null },
      select: { id: true },
    });

    return this.tenantDb.db.payment.findMany({
      where: {
        tenantId,
        deletedAt: null,
        isReturn: false,
        OR: [
          { saleId },
          ...(invoice ? [{ invoiceId: invoice.id }] : []),
        ],
      },
      include: { account: { select: { name: true } } },
      orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private async syncSalePaymentStatus(saleId: string, tenantId: string) {
    const sale = await this.tenantDb.db.sale.findFirst({
      where: { id: saleId, tenantId, deletedAt: null },
      select: { id: true, total: true, customerId: true, paymentStatus: true },
    });
    if (!sale) return;

    // Same scope as list/View Payments: saleId + invoice-linked rows.
    const payments = await this.listSalePaymentRows(saleId, tenantId);
    const paidTotal = payments.reduce((sum, row) => sum + toNumber(row.amount), 0);
    const total = toNumber(sale.total);
    const paymentStatus = paymentStatusFromAmounts(
      total,
      paidTotal,
      sale.paymentStatus,
    );
    const paymentMethod =
      payments.find((row) => row.method?.trim())?.method?.trim() || null;

    await this.tenantDb.db.sale.update({
      where: { id: saleId },
      data: {
        paymentStatus,
        totalPaid: paidTotal,
        ...(paymentMethod ? { paymentMethod } : {}),
      },
    });

    if (sale.customerId) {
      await refreshCustomerFinancialRollups(this.tenantDb.db, sale.customerId);
    }
    // Await list bust before pay APIs return — otherwise React Query refetch
    // can hit a stale sales:v2 page and flip Paid → Due.
    await invalidateTenantDashboardCache(this.cache, tenantId);
    await invalidateTenantListCache(this.cache, tenantId, ['sales:v2', 'sales']);
  }

  /** HQ6 sales row “Add payment” — post one payment against an open sale. */
  async addPayment(
    saleId: string,
    body: {
      amount: number;
      method?: string;
      note?: string;
      paidOn?: string;
      accountId?: string;
      paymentRefNo?: string;
    },
  ) {
    const tenantId = this.tenantDb.requireTenantId();
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter a valid payment amount');
    }
    const accountId = body.accountId?.trim() || null;
    if (!accountId) {
      throw new BadRequestException(
        'Select a Payment Account so this payment posts to the account book',
      );
    }

    const sale = await this.tenantDb.db.sale.findFirst({
      where: { id: saleId, tenantId, deletedAt: null },
      include: {
        payments: {
          where: { deletedAt: null, isReturn: false },
          select: { amount: true },
        },
      },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    if (
      sale.status === 'draft' ||
      sale.status === 'quotation' ||
      sale.status === 'refunded' ||
      sale.status === 'written_off'
    ) {
      throw new BadRequestException(
        'Convert the quotation/draft to an invoice before adding payment',
      );
    }

    const total = toNumber(sale.total);
    const alreadyPaid = sale.payments.reduce(
      (sum, row) => sum + toNumber(row.amount),
      0,
    );
    const due = Math.max(0, total - alreadyPaid);
    if (due <= 0) {
      throw new BadRequestException('Sale is already paid');
    }

    const apply = Math.min(amount, due);
    const paidOn = body.paidOn ? new Date(body.paidOn) : new Date();
    const method = body.method?.trim() || 'cash';
    const createdBy = await this.auditService.createdByFields();

    const created = await this.tenantDb.db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tenantId,
          amount: apply,
          currency: sale.currency || 'NGN',
          method,
          paidOn,
          paymentFor: 'sale',
          paymentRefNo:
            body.paymentRefNo?.trim() ||
            `SP${paidOn.getFullYear()}/${sale.reference}`,
          saleId: sale.id,
          accountId,
          note: body.note?.trim() || `Sale payment — ${sale.reference}`,
          createdByName: createdBy.createdByName ?? null,
        },
        include: { account: { select: { name: true } } },
      });

      await recordPaymentAccountTxn(tx, {
        tenantId,
        accountId,
        type: 'credit',
        subType: 'sale_payment',
        amount: apply,
        operationDate: paidOn,
        refNo: payment.paymentRefNo,
        note: body.note?.trim() || `Sale payment — ${sale.reference}`,
        paymentMethod: method,
        saleId: sale.id,
        paymentId: payment.id,
        createdByName: createdBy.createdByName ?? null,
      });

      return payment;
    });

    await this.syncSalePaymentStatus(saleId, tenantId);
    const remainingDue = Math.max(0, due - apply);
    const totalPaidAfter = alreadyPaid + apply;
    const nextPaymentStatus = paymentStatusFromAmounts(total, totalPaidAfter);
    await this.auditService.log({
      action: 'created',
      entityType: 'payment',
      entityId: created.id,
      summary: `Added payment on sale ${sale.reference}`,
      metadata: {
        amount: apply,
        from: sale.paymentStatus ?? 'due',
        to: nextPaymentStatus,
      },
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'sale',
      entityId: saleId,
      summary: `Payment added on sale ${sale.reference}`,
      metadata: {
        from: sale.paymentStatus ?? 'due',
        to: nextPaymentStatus,
        paymentStatus: nextPaymentStatus,
      },
    });

    return {
      id: created.id,
      amount: toNumber(created.amount),
      amountApplied: apply,
      remainingDue,
      paymentStatus: paymentStatusFromAmounts(total, totalPaidAfter),
      totalPaid: totalPaidAfter,
      currency: created.currency,
      method: created.method,
      paymentRefNo: created.paymentRefNo,
      paidOn: created.paidOn ? toIso(created.paidOn) : null,
      note: created.note,
      accountId: created.accountId,
      accountName: created.account?.name ?? null,
      createdByName: created.createdByName,
    };
  }

  async updatePayment(
    saleId: string,
    paymentId: string,
    body: {
      amount?: number;
      method?: string | null;
      note?: string | null;
      paidOn?: string | null;
      accountId?: string | null;
      paymentRefNo?: string | null;
    },
  ) {
    const tenantId = this.tenantDb.requireTenantId();
    const payment = await this.tenantDb.db.payment.findFirst({
      where: {
        id: paymentId,
        saleId,
        tenantId,
        deletedAt: null,
        isReturn: false,
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    const amount =
      body.amount !== undefined ? Number(body.amount) : toNumber(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter a valid payment amount');
    }

    const updated = await this.tenantDb.db.$transaction(async (tx) => {
      const row = await tx.payment.update({
        where: { id: paymentId },
        data: {
          amount,
          ...(body.method !== undefined
            ? { method: body.method?.trim() || null }
            : {}),
          ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
          ...(body.paidOn !== undefined
            ? { paidOn: body.paidOn ? new Date(body.paidOn) : null }
            : {}),
          ...(body.accountId !== undefined
            ? { accountId: body.accountId || null }
            : {}),
          ...(body.paymentRefNo !== undefined
            ? { paymentRefNo: body.paymentRefNo?.trim() || null }
            : {}),
        },
        include: { account: { select: { name: true } } },
      });

      // Keep payment-account book in sync (amount/account changes used to wipe
      // the link in the UI and never rewrite the ledger credit).
      await syncSalePaymentAccountCredit(tx, {
        tenantId,
        paymentId: row.id,
        accountId: row.accountId,
        amount: toNumber(row.amount),
        operationDate: row.paidOn ?? row.createdAt,
        refNo: row.paymentRefNo,
        note: row.note ?? `Sale payment`,
        paymentMethod: row.method,
        saleId: row.saleId,
        createdByName: row.createdByName,
      });

      return row;
    });

    await this.syncSalePaymentStatus(saleId, tenantId);
    await this.auditService.log({
      action: 'updated',
      entityType: 'payment',
      entityId: paymentId,
      summary: `Updated payment on sale ${saleId}`,
    });

    return {
      id: updated.id,
      amount: toNumber(updated.amount),
      currency: updated.currency,
      method: updated.method,
      paymentRefNo: updated.paymentRefNo,
      paidOn: updated.paidOn ? toIso(updated.paidOn) : null,
      note: updated.note,
      accountId: updated.accountId,
      accountName: updated.account?.name ?? null,
      createdByName: updated.createdByName,
    };
  }

  async removePayment(saleId: string, paymentId: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const payment = await this.tenantDb.db.payment.findFirst({
      where: {
        id: paymentId,
        saleId,
        tenantId,
        deletedAt: null,
        isReturn: false,
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    await this.tenantDb.db.$transaction(async (tx) => {
      await softDeletePaymentAccountTxns(tx, { tenantId, paymentId });
      await tx.payment.update({
        where: { id: paymentId },
        data: { deletedAt: new Date() },
      });
    });
    await this.syncSalePaymentStatus(saleId, tenantId);
    await this.auditService.log({
      action: 'deleted',
      entityType: 'payment',
      entityId: paymentId,
      summary: `Deleted payment on sale ${saleId}`,
    });
  }

  /** HQ6 “Invoice URL” share link (public `/invoice/:token`, no login). */
  async getInvoiceShareUrl(id: string): Promise<{ token: string; path: string }> {
    const tenantId = this.tenantDb.requireTenantId();
    const sale = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    const token = encodePublicInvoiceToken(sale.id);
    return { token, path: `/invoice/${token}` };
  }

  async importCsv(csv: string): Promise<CsvImportResult> {
    const rows = parseCsv(csv);
    const result: CsvImportResult = { created: 0, updated: 0, errors: [] };

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const sku = pickCsvField(row, 'sku', 'product sku');
      const name = pickCsvField(row, 'name', 'product name', 'product');
      const quantityRaw = pickCsvField(row, 'quantity', 'qty');
      const priceRaw = pickCsvField(row, 'unit_price', 'price', 'unit price');
      const quantity = Number(quantityRaw || '1');
      const unitPrice = Number(priceRaw || '0');
      if (!sku && !name) {
        result.errors.push({
          row: index + 2,
          message: 'SKU or product name is required',
        });
        continue;
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        result.errors.push({ row: index + 2, message: 'Invalid quantity' });
        continue;
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        result.errors.push({ row: index + 2, message: 'Invalid unit price' });
        continue;
      }

      const reference =
        pickCsvField(row, 'reference', 'invoice no', 'invoice') ||
        `IMPORT-${Date.now().toString(36).toUpperCase()}-${index + 1}`;
      const customerName = pickCsvField(row, 'customer', 'customer name') || undefined;
      const dateRaw = pickCsvField(row, 'date', 'sale date');
      const paymentAmount = Number(
        pickCsvField(row, 'payment_amount', 'amount paid', 'paid') || String(quantity * unitPrice),
      );
      const paymentMethod = pickCsvField(row, 'payment_method', 'method') || 'cash';

      let itemId: string | undefined;
      if (sku) {
        const item = await this.tenantDb.db.item.findFirst({
          where: {
            tenantId: this.tenantDb.requireTenantId(),
            deletedAt: null,
            sku: { equals: sku, mode: 'insensitive' },
          },
        });
        itemId = item?.id;
      }

      try {
        await this.create({
          reference,
          customerName,
          date: dateRaw ? new Date(dateRaw).toISOString() : undefined,
          lines: [
            {
              itemId,
              sku: sku || `SKU-${index + 1}`,
              name: name || sku,
              quantity,
              unitPrice,
            },
          ],
          payments: [{ amount: paymentAmount, method: paymentMethod }],
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

  private linesFromJob(job: {
    reference: string;
    invoiceAmount: { toString(): string } | null;
    materials: Array<{
      itemId: string | null;
      name: string;
      quantity: { toString(): string };
      unitCost: { toString(): string };
    }>;
    labourEntries: Array<{
      hours: { toString(): string };
      rate: { toString(): string };
      totalCost: { toString(): string };
      staffId: string;
    }>;
  }): SaleLineInput[] {
    const materialLines = job.materials.map((row, index) => ({
      itemId: row.itemId ?? undefined,
      sku: row.itemId ? `PART-${index + 1}` : `JOB-MAT-${index + 1}`,
      name: row.name,
      quantity: Math.max(0.01, toNumber(row.quantity)),
      unitPrice: toNumber(row.unitCost),
    }));
    const labourLines = job.labourEntries.map((row, index) => ({
      sku: `LABOUR-${index + 1}`,
      name: `Labour`,
      quantity: Math.max(0.01, toNumber(row.hours)),
      unitPrice: toNumber(row.rate),
    }));
    const lines = [...materialLines, ...labourLines];
    if (lines.length > 0) return lines;
    const amount = job.invoiceAmount != null ? toNumber(job.invoiceAmount) : 0;
    return [
      {
        sku: `JOB-${job.reference}`,
        name: `Job ${job.reference}`,
        quantity: 1,
        unitPrice: Math.max(0, amount),
      },
    ];
  }

  private toSale(
    row: {
    id: string;
    tenantId: string;
    reference: string;
    customerId: string | null;
    customer: { name: string; phone?: string | null } | null;
    jobId?: string | null;
    job?: { reference: string; vehicleLabel?: string | null } | null;
    total: { toString(): string };
    discountAmount: { toString(): string } | null;
    taxAmount: { toString(): string } | null;
    notes: string | null;
    originalSaleId?: string | null;
    originalSale?: { reference: string } | null;
    currency: string;
    status: string;
    paymentStatus: string | null;
    paymentMethod?: string | null;
    cleanerUserId?: string | null;
    cleanerName?: string | null;
    serviceStaffEmployeeId?: string | null;
    serviceStaffEmployee?: { name: string } | null;
    locationCode: string | null;
    shippingStatus: string | null;
    shippingAddress: string | null;
    trackingNumber: string | null;
    date: Date;
    createdByUserId: string | null;
    createdByName: string | null;
    createdAt: Date;
    updatedAt: Date;
    lines?: Array<unknown>;
    _count?: { lines: number };
    payments?: Array<{ amount: { toString(): string } | number }>;
  },
    /** When set (list path), use this paid total instead of row.payments / status. */
    paidTotalOverride?: number,
    /** When set (list path), payment note(s) aggregated from Payment rows. */
    paymentNoteOverride?: string | null,
  ): Sale {
    const total = toNumber(row.total);
    const paidFromRows =
      row.payments?.reduce((sum, payment) => sum + toNumber(payment.amount), 0) ??
      0;
    // Prefer batch paid total (list) or loaded payment rows. Never treat a stored
    // "paid" label as proof of payment — migration left many unpaid rows as paid.
    const hasPaymentMath =
      paidTotalOverride != null || row.payments !== undefined;
    const totalPaid = hasPaymentMath
      ? (paidTotalOverride != null ? paidTotalOverride : paidFromRows)
      : row.paymentStatus === 'paid'
        ? total
        : 0;
    const sellDue = Math.max(0, total - totalPaid);
    const paymentStatus = hasPaymentMath
      ? paymentStatusFromAmounts(total, totalPaid, row.paymentStatus)
      : (row.paymentStatus as PaymentStatus | null);

    const paymentNoteFromRows =
      row.payments
        ?.map((p) =>
          'note' in p && typeof (p as { note?: string | null }).note === 'string'
            ? (p as { note?: string | null }).note?.trim()
            : null,
        )
        .filter((n): n is string => Boolean(n))
        .filter((n, i, arr) => arr.indexOf(n) === i)
        .join(', ') || null;

    return {
      id: row.id,
      tenantId: row.tenantId,
      reference: row.reference,
      customerId: row.customerId,
      customerName: row.customer?.name ?? 'Walk-in',
      customerPhone: row.customer?.phone ?? null,
      jobId: row.jobId ?? null,
      jobReference: row.job?.reference ?? null,
      total,
      discountAmount: row.discountAmount ? toNumber(row.discountAmount) : null,
      taxAmount: row.taxAmount ? toNumber(row.taxAmount) : null,
      notes: row.notes,
      paymentNote:
        paymentNoteOverride !== undefined
          ? paymentNoteOverride
          : paymentNoteFromRows,
      originalSaleId: row.originalSaleId ?? null,
      originalSaleReference: row.originalSale?.reference ?? null,
      currency: row.currency,
      status: mapSaleStatusToUi(row.status),
      recordStatus: row.status as Sale['recordStatus'],
      paymentStatus,
      paymentMethod: row.paymentMethod ?? null,
      totalPaid,
      sellDue,
      cleanerUserId: row.cleanerUserId ?? null,
      cleanerName: row.cleanerName ?? null,
      serviceStaffEmployeeId: row.serviceStaffEmployeeId ?? null,
      serviceStaffEmployeeName:
        row.serviceStaffEmployee?.name ?? row.cleanerName ?? null,
      locationCode: row.locationCode,
      shippingStatus: row.shippingStatus as Sale['shippingStatus'],
      shippingAddress: row.shippingAddress,
      trackingNumber: row.trackingNumber,
      itemCount: row._count?.lines ?? row.lines?.length ?? 0,
      date: toIso(row.date).slice(0, 10),
      createdByUserId: row.createdByUserId,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  private toSaleDetail(row: {
    id: string;
    tenantId: string;
    reference: string;
    customerId: string | null;
    customer: {
      name: string;
      email?: string | null;
      phone?: string | null;
      totalSellDue?: { toString(): string } | number | null;
    } | null;
    jobId?: string | null;
    job?: { reference: string; vehicleLabel?: string | null } | null;
    total: { toString(): string };
    discountAmount: { toString(): string } | null;
    taxAmount: { toString(): string } | null;
    notes: string | null;
    originalSaleId?: string | null;
    originalSale?: { reference: string } | null;
    currency: string;
    status: string;
    paymentStatus: string | null;
    paymentMethod?: string | null;
    cleanerUserId?: string | null;
    cleanerName?: string | null;
    serviceStaffEmployeeId?: string | null;
    serviceStaffEmployee?: { name: string } | null;
    locationCode: string | null;
    shippingStatus: string | null;
    shippingAddress: string | null;
    trackingNumber: string | null;
    date: Date;
    createdByUserId: string | null;
    createdByName: string | null;
    createdAt: Date;
    updatedAt: Date;
    payments?: Array<{ amount: { toString(): string } | number }>;
    lines: Array<{
      id: string;
      saleId: string;
      itemId: string | null;
      sku: string;
      name: string;
      quantity: { toString(): string };
      unitPrice: { toString(): string };
      lineTotal: { toString(): string };
      discountAmount: { toString(): string } | null;
      sourceTenantCode?: string | null;
      supplierId?: string | null;
    }>;
  }): SaleDetail {
    const base = this.toSale(row);
    const lines: SaleLine[] = row.lines.map((line) => ({
      id: line.id,
      saleId: line.saleId,
      itemId: line.itemId,
      sku: line.sku,
      name: line.name,
      quantity: toNumber(line.quantity),
      unitPrice: toNumber(line.unitPrice),
      lineTotal: toNumber(line.lineTotal),
      discountAmount: line.discountAmount
        ? toNumber(line.discountAmount)
        : null,
      sourceTenantCode: line.sourceTenantCode ?? null,
      supplierId: line.supplierId ?? null,
    }));
    return {
      ...base,
      lines,
      customerEmail: row.customer?.email ?? null,
      customerPhone: row.customer?.phone ?? null,
      customerBusinessName: null,
      customerTotalSellDue:
        row.customer?.totalSellDue != null
          ? toNumber(row.customer.totalSellDue)
          : null,
      vehicleLabel: row.job?.vehicleLabel ?? null,
      invoicePath: `/invoice/${encodePublicInvoiceToken(row.id)}`,
    };
  }
}

export async function warmDefaultSalesListPages(
  prisma: import('@prisma/client').PrismaClient,
  cache: CacheService,
  tenantId: string,
): Promise<void> {

  for (const limit of HQ6_LIST_WARM_LIMITS) {
    for (const sort of hq6WarmSorts({ sortBy: 'updatedAt', sortDir: 'desc' })) {
      for (const includeSummary of [false, true] as const) {
        const filterKey = listPageFilterKey({
          search: undefined,
          from: undefined,
          to: undefined,
          locationCode: undefined,
          customerId: undefined,
          jobId: undefined,
          paymentStatus: undefined,
          paymentMethod: undefined,
          cleanerUserId: undefined,
          serviceStaffEmployeeId: undefined,
          createdByUserId: undefined,
          status: undefined,
          saleStatus: undefined,
          returnsOnly: 0,
          shipmentsOnly: 0,
          cursor: undefined,
          limit,
          sortBy: sort.sortBy,
          sortDir: sort.sortDir,
          sum: includeSummary ? 1 : 0,
        });
        await withListPageCache(
          cache,
          tenantId,
          'sales:v2',
          filterKey,
          async () => {
            const baseWhere = { tenantId, deletedAt: null };
            const [rows, totalCount, saleAmountAgg] = await Promise.all([
              prisma.sale.findMany({
                where: baseWhere,
                select: {
                  id: true,
                  tenantId: true,
                  reference: true,
                  customerId: true,
                  customer: { select: { name: true, phone: true } },
                  jobId: true,
                  job: { select: { reference: true } },
                  total: true,
                  discountAmount: true,
                  taxAmount: true,
                  notes: true,
                  originalSaleId: true,
                  currency: true,
                  status: true,
                  paymentStatus: true,
                  paymentMethod: true,
                  totalPaid: true,
                  itemCount: true,
                  cleanerUserId: true,
                  cleanerName: true,
                  serviceStaffEmployeeId: true,
                  serviceStaffEmployee: { select: { name: true } },
                  locationCode: true,
                  shippingStatus: true,
                  shippingAddress: true,
                  trackingNumber: true,
                  date: true,
                  createdByUserId: true,
                  createdByName: true,
                  createdAt: true,
                  updatedAt: true,
                },
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                take: limit,
              }),
              includeSummary
                ? prisma.sale.count({ where: baseWhere })
                : Promise.resolve(undefined as number | undefined),
              includeSummary
                ? prisma.sale.aggregate({
                    where: baseWhere,
                    _sum: { total: true },
                  })
                : Promise.resolve(undefined),
            ]);

            const items = rows.map((row) => {
              const total = toNumber(row.total);
              const totalPaid = toNumber(row.totalPaid ?? 0);
              const sellDue = Math.max(0, total - totalPaid);
              return {
                id: row.id,
                tenantId: row.tenantId,
                reference: row.reference,
                customerId: row.customerId,
                customerName: row.customer?.name ?? 'Walk-in',
                customerPhone: row.customer?.phone ?? null,
                jobId: row.jobId ?? null,
                jobReference: row.job?.reference ?? null,
                total,
                discountAmount: row.discountAmount
                  ? toNumber(row.discountAmount)
                  : null,
                taxAmount: row.taxAmount ? toNumber(row.taxAmount) : null,
                notes: row.notes,
                paymentNote: null as string | null,
                originalSaleId: row.originalSaleId ?? null,
                originalSaleReference: null,
                currency: row.currency,
                status: mapSaleStatusToUi(row.status),
                recordStatus: row.status,
                paymentStatus: paymentStatusFromAmounts(
                  total,
                  totalPaid,
                  row.paymentStatus,
                ),
                paymentMethod: row.paymentMethod ?? null,
                totalPaid,
                sellDue,
                cleanerUserId: row.cleanerUserId ?? null,
                cleanerName: row.cleanerName ?? null,
                serviceStaffEmployeeId: row.serviceStaffEmployeeId ?? null,
                serviceStaffEmployeeName:
                  row.serviceStaffEmployee?.name?.trim() ||
                  row.cleanerName ||
                  null,
                locationCode: row.locationCode,
                shippingStatus: row.shippingStatus,
                shippingAddress: row.shippingAddress,
                trackingNumber: row.trackingNumber,
                itemCount: row.itemCount ?? 0,
                date: toIso(row.date).slice(0, 10),
                createdByUserId: row.createdByUserId,
                createdByName: row.createdByName,
                createdAt: toIso(row.createdAt),
                updatedAt: toIso(row.updatedAt),
              };
            });
            if (!includeSummary || totalCount == null || saleAmountAgg == null) {
              return { items };
            }
            return {
              items,
              totalCount,
              amountSummary: {
                totalAmount: toNumber(saleAmountAgg._sum.total),
                currency: 'NGN',
              },
            };
          },
          600,
        );
      }
    }
  }
}
