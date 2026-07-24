import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ContactDueSummary,
  ContactLedgerEntry,
  CsvImportResult,
  PayContactDueRequest,
  PayContactDueResult,
  Supplier,
  SupplierFilters,
  SupplierListRow,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { AuditService } from '../audit/audit.service';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import {
  getLegacyContactIdsForPage,
  warmLegacyContactIdMap,
} from '../../common/utils/legacyContactIdMap';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import type { PaginatedList } from '../../common/utils/paginatedList';
import { parseCsv, pickCsvField } from '../../common/utils/csvImport';
import {
  parseMovementLines,
  toIso,
  toNumber,
} from '../../common/utils/serializers';
import {
  refreshSupplierPurchaseRollups,
  supplierActivityStatus,
} from '../../common/utils/supplierRollups';

export interface SupplierKpiSummary {
  totalSuppliers: number;
  onTimeRate: number;
  avgLeadTimeDays: number;
  openPoValue: number;
  currency: string;
}

function serializeSupplier(row: {
  id: string;
  tenantId: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  locationCode: string | null;
  notes: string | null;
  taxNumber?: string | null;
  status?: string | null;
  openingBalance?: { toString(): string } | number | null;
  assignedToUserId?: string | null;
  assignedToUser?: { name: string } | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Supplier {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone,
    address: row.address,
    locationCode: row.locationCode,
    notes: row.notes,
    taxNumber: row.taxNumber?.trim() || null,
    openingBalance: toNumber(row.openingBalance ?? 0),
    assignedToUserId: row.assignedToUserId ?? null,
    assignedToName: row.assignedToUser?.name ?? null,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toListRow(
  row: Parameters<typeof serializeSupplier>[0] & {
    totalPurchase?: { toString(): string } | number;
    totalPurchaseDue?: { toString(): string } | number;
    totalPurchasePaid?: { toString(): string } | number;
    totalPurchaseReturn?: { toString(): string } | number;
    totalAdvance?: { toString(): string } | number;
    lastPurchaseAt?: Date | null;
  },
  extras?: {
    contactId?: string | null;
  },
): SupplierListRow {
  const storedStatus =
    row.status === 'inactive' ? 'inactive' : row.status === 'active' ? 'active' : null;
  return {
    ...serializeSupplier(row),
    category: 'General',
    leadTimeDays: 7,
    location: row.locationCode ?? row.address ?? '—',
    rating: 4.5,
    contactId: extras?.contactId ?? row.id.slice(0, 8).toUpperCase(),
    businessName: row.name,
    taxNumber: row.taxNumber?.trim() || null,
    payTerm: null,
    totalPurchase: toNumber(row.totalPurchase ?? 0),
    totalPurchaseDue: toNumber(row.totalPurchaseDue ?? 0),
    totalPurchasePaid: toNumber(row.totalPurchasePaid ?? 0),
    totalPurchaseReturn: toNumber(row.totalPurchaseReturn ?? 0),
    totalAdvance: toNumber(row.totalAdvance ?? 0),
    status: storedStatus ?? supplierActivityStatus(row.lastPurchaseAt),
  };
}

@Injectable()
export class SuppliersService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly auditService: AuditService,
    private readonly cache: CacheService,
  ) {}

  async list(filters: SupplierFilters = {}): Promise<PaginatedList<SupplierListRow>> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      status: filters.status,
      assignedToUserId: filters.assignedToUserId,
      openingBalance: filters.openingBalance ? 1 : 0,
      purchaseDue: filters.purchaseDue ? 1 : 0,
      purchaseReturn: filters.purchaseReturn ? 1 : 0,
      advanceBalance: filters.advanceBalance ? 1 : 0,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sum: filters.includeSummary === false ? 0 : 1,
    });

    return withListPageCache(
      this.cache,
      tenantId,
      'suppliers',
      filterKey,
      () => this.listUncached(filters, tenantId),
    );
  }

  private async listUncached(
    filters: SupplierFilters,
    tenantId: string,
  ): Promise<PaginatedList<SupplierListRow>> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'string',
    });

    const baseWhere = {
      tenantId,
      deletedAt: null as null,
      ...(filters.assignedToUserId
        ? { assignedToUserId: filters.assignedToUserId }
        : {}),
      ...(filters.openingBalance ? { openingBalance: { gt: 0 } } : {}),
      ...(filters.purchaseDue ? { totalPurchaseDue: { gt: 0 } } : {}),
      ...(filters.purchaseReturn ? { totalPurchaseReturn: { gt: 0 } } : {}),
      ...(filters.advanceBalance ? { totalAdvance: { gt: 0 } } : {}),
      ...(filters.status === 'active' || filters.status === 'inactive'
        ? { status: filters.status }
        : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' as const } },
              {
                contactName: {
                  contains: filters.search,
                  mode: 'insensitive' as const,
                },
              },
              { email: { contains: filters.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    // Rows first; legacy IDs from warm map (0 RTT) or page-scoped IN (1 RTT).
    const includeSummary = filters.includeSummary !== false;
    const [rows, totalCount, amountAgg] = await Promise.all([
      this.tenantDb.db.supplier.findMany({
        where: {
          ...baseWhere,
          ...(pagination.where ?? {}),
        },
        include: { assignedToUser: { select: { name: true } } },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: pagination.take,
      }),
      includeSummary
        ? this.tenantDb.db.supplier.count({ where: baseWhere })
        : Promise.resolve(undefined as number | undefined),
      includeSummary
        ? this.tenantDb.db.supplier.aggregate({
            where: baseWhere,
            _sum: {
              totalPurchase: true,
              totalPurchaseDue: true,
              totalPurchasePaid: true,
            },
          })
        : Promise.resolve(undefined),
    ]);

    const legacyById = await getLegacyContactIdsForPage(
      this.tenantDb.db,
      this.cache,
      tenantId,
      'supplier',
      rows.map((row) => row.id),
    );

    const items = rows.map((row) =>
      toListRow(row, { contactId: legacyById.get(row.id) ?? null }),
    );

    if (!includeSummary || totalCount == null || amountAgg == null) {
      return { items };
    }

    // Trust denormalized purchase totals on list (refreshed on movement write).
    return {
      items,
      totalCount,
      amountSummary: {
        totalAmount: toNumber(amountAgg._sum.totalPurchase),
        totalDue: toNumber(amountAgg._sum.totalPurchaseDue),
        totalPaid: toNumber(amountAgg._sum.totalPurchasePaid),
        currency: 'NGN',
      },
    };
  }

  async kpiSummary(): Promise<SupplierKpiSummary> {
    const tenantId = this.tenantDb.requireTenantId();
    const total = await this.tenantDb.db.supplier.count({
      where: { tenantId, deletedAt: null },
    });
    return {
      totalSuppliers: total,
      onTimeRate: 92,
      avgLeadTimeDays: 7,
      openPoValue: 0,
      currency: 'NGN',
    };
  }

  async getById(id: string): Promise<SupplierListRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Supplier not found');
    await refreshSupplierPurchaseRollups(this.tenantDb.db, id);
    const row = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { assignedToUser: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Supplier not found');
    return toListRow(row);
  }

  async getMeta(id: string): Promise<{ id: string; name: string }> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!row) throw new NotFoundException('Supplier not found');
    return row;
  }

  async create(body: {
    name: string;
    contactName?: string;
    email?: string;
    phone?: string;
    address?: string;
    locationCode?: string;
    notes?: string;
    taxNumber?: string | null;
    openingBalance?: number;
    assignedToUserId?: string;
  }): Promise<SupplierListRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const createdBy = await this.auditService.createdByFields();
    const locationCode = await this.tenantDb.resolveBusinessLocation(
      body.locationCode,
    );
    const row = await this.tenantDb.db.supplier.create({
      data: {
        tenantId,
        name: body.name,
        contactName: body.contactName ?? null,
        email: body.email ?? null,
        phone: body.phone ?? null,
        address: body.address ?? null,
        locationCode,
        notes: body.notes ?? null,
        taxNumber: body.taxNumber?.trim() || null,
        openingBalance: body.openingBalance ?? 0,
        assignedToUserId: body.assignedToUserId ?? null,
        ...createdBy,
      },
      include: { assignedToUser: { select: { name: true } } },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'supplier',
      entityId: row.id,
      summary: `Created supplier ${row.name}`,
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return toListRow(row);
  }

  async update(
    id: string,
    body: Partial<{
      name: string;
      contactName: string;
      email: string;
      phone: string;
      address: string;
      notes: string;
      taxNumber: string | null;
      openingBalance: number;
      assignedToUserId: string;
      status: 'active' | 'inactive';
    }>,
  ): Promise<SupplierListRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Supplier not found');

    const row = await this.tenantDb.db.supplier.update({
      where: { id },
      data: {
        ...body,
        ...(body.taxNumber !== undefined
          ? { taxNumber: body.taxNumber?.trim() || null }
          : {}),
      },
      include: { assignedToUser: { select: { name: true } } },
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'supplier',
      entityId: id,
      summary: `Updated supplier ${row.name}`,
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return toListRow(row);
  }

  async setStatus(
    id: string,
    status: 'active' | 'inactive',
  ): Promise<SupplierListRow> {
    return this.update(id, { status });
  }

  async getSummary(id: string): Promise<ContactDueSummary> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Supplier not found');
    await refreshSupplierPurchaseRollups(this.tenantDb.db, id);
    const row = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        id: true,
        totalPurchase: true,
        totalPurchasePaid: true,
        totalPurchaseDue: true,
      },
    });
    if (!row) throw new NotFoundException('Supplier not found');
    return {
      contactId: row.id,
      totalAmount: toNumber(row.totalPurchase),
      totalPaid: toNumber(row.totalPurchasePaid),
      totalDue: toNumber(row.totalPurchaseDue),
      currency: 'NGN',
    };
  }

  async getLedger(
    id: string,
    cursor?: string,
    limit = 50,
  ): Promise<ContactLedgerEntry[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const supplier = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const movements = await this.tenantDb.db.stockMovement.findMany({
      where: { tenantId, supplierId: id, deletedAt: null },
      select: { id: true, reference: true },
    });
    const movementIds = movements.map((movement) => movement.id);
    const refById = new Map(
      movements.map((movement) => [movement.id, movement.reference]),
    );

    const pagination = buildCompositeCursorQuery({
      sortField: 'date',
      sortDir: 'desc',
      cursor,
      limit,
      sortValueType: 'date',
    });
    const ledgerRows = await this.tenantDb.db.ledgerEntry.findMany({
      where: {
        tenantId,
        deletedAt: null,
        linkedRecordType: 'stock_movement',
        linkedRecordId: { in: movementIds },
        ...(pagination.where ?? {}),
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });

    return ledgerRows.map((entry) => ({
      id: entry.id,
      date: toIso(entry.date),
      type: entry.type,
      description: entry.description,
      amount: toNumber(entry.amount),
      currency: entry.currency,
      linkedRecordType: entry.linkedRecordType,
      linkedRecordId: entry.linkedRecordId,
      reference:
        entry.linkedRecordId != null
          ? (refById.get(entry.linkedRecordId) ?? null)
          : null,
    }));
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!existing) throw new NotFoundException('Supplier not found');
    await this.tenantDb.db.supplier.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.auditService.log({
      action: 'deleted',
      entityType: 'supplier',
      entityId: id,
      summary: `Deleted supplier ${existing.name}`,
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
  }

  /** Apply contact payment across oldest due/partial inbound purchases (HQ6 pay-contact-due). */
  async payDue(
    id: string,
    dto: PayContactDueRequest,
  ): Promise<PayContactDueResult> {
    const tenantId = this.tenantDb.requireTenantId();
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Payment amount must be greater than zero');
    }

    const supplier = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const openMovements = await this.tenantDb.db.stockMovement.findMany({
      where: {
        tenantId,
        supplierId: id,
        deletedAt: null,
        type: 'inbound',
        source: { not: 'purchase_return' },
        OR: [
          { paymentStatus: { in: ['due', 'partial'] } },
          { paymentStatus: null },
        ],
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });

    if (openMovements.length === 0) {
      throw new BadRequestException(
        'No outstanding purchase due for this supplier',
      );
    }

    let remaining = amount;
    let paymentsCreated = 0;
    const paidOn = dto.paidOn ? new Date(dto.paidOn) : new Date();
    const method = dto.method?.trim() || 'cash';
    const createdBy = await this.auditService.createdByFields();

    await this.tenantDb.db.$transaction(async (tx) => {
      for (const movement of openMovements) {
        if (remaining <= 0) break;
        const total = parseMovementLines(movement.lines).reduce(
          (sum, line) =>
            sum +
            line.quantity *
              toNumber((line as { unitCost?: number }).unitCost ?? 0),
          0,
        );
        if (total <= 0) continue;

        const apply = Math.min(remaining, total);
        const payment = await tx.payment.create({
          data: {
            tenantId,
            amount: apply,
            currency: 'NGN',
            method,
            paidOn,
            paymentFor: 'purchase',
            paymentRefNo: movement.reference,
            accountId: dto.accountId?.trim() || null,
            note:
              dto.note?.trim() ||
              `Supplier payment — ${supplier.name} (${movement.reference})`,
            createdByName: createdBy.createdByName ?? null,
          },
        });

        await tx.ledgerEntry.create({
          data: {
            tenantId,
            type: 'cost',
            amount: apply,
            currency: 'NGN',
            category: 'Supplier Payment',
            description: `Payment on ${movement.reference}`,
            linkedRecordType: 'payment',
            linkedRecordId: payment.id,
            date: paidOn,
          },
        });

        const paymentStatus = apply >= total - 0.001 ? 'paid' : 'partial';
        await tx.stockMovement.update({
          where: { id: movement.id },
          data: {
            paymentStatus,
            paymentMethod: method,
          },
        });

        remaining -= apply;
        paymentsCreated += 1;
      }
    });

    if (paymentsCreated === 0) {
      throw new BadRequestException('No outstanding balance could be applied');
    }

    await refreshSupplierPurchaseRollups(this.tenantDb.db, id);
    const summary = await this.getSummary(id);
    await this.auditService.log({
      action: 'updated',
      entityType: 'supplier',
      entityId: id,
      summary: `Recorded payment of ${amount - remaining} for ${supplier.name}`,
    });

    return {
      contactId: id,
      amountApplied: amount - remaining,
      currency: summary.currency,
      paymentsCreated,
      remainingDue: summary.totalDue,
    };
  }

  /** Items purchased from this supplier (HQ6 contact stock report). */
  async stockReport(id: string): Promise<
    Array<{
      itemId: string;
      sku: string;
      name: string;
      quantity: number;
      totalCost: number;
    }>
  > {
    const tenantId = this.tenantDb.requireTenantId();
    const supplier = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const movements = await this.tenantDb.db.stockMovement.findMany({
      where: {
        tenantId,
        supplierId: id,
        deletedAt: null,
        type: 'inbound',
        source: { not: 'purchase_return' },
      },
      select: { lines: true },
    });

    const byItem = new Map<
      string,
      { itemId: string; sku: string; name: string; quantity: number; totalCost: number }
    >();

    for (const movement of movements) {
      for (const line of parseMovementLines(movement.lines)) {
        const unitCost = toNumber((line as { unitCost?: number }).unitCost ?? 0);
        const key = line.itemId || line.sku;
        const existing = byItem.get(key);
        if (existing) {
          existing.quantity += line.quantity;
          existing.totalCost += line.quantity * unitCost;
        } else {
          byItem.set(key, {
            itemId: line.itemId,
            sku: line.sku,
            name: line.name,
            quantity: line.quantity,
            totalCost: line.quantity * unitCost,
          });
        }
      }
    }

    return Array.from(byItem.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async importCsv(csv: string): Promise<CsvImportResult> {
    const rows = parseCsv(csv);
    const result: CsvImportResult = { created: 0, updated: 0, errors: [] };

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = pickCsvField(row, 'name', 'supplier name', 'business name');
      if (!name) {
        result.errors.push({ row: index + 2, message: 'Name is required' });
        continue;
      }
      try {
        await this.create({
          name,
          contactName: pickCsvField(row, 'contact name') || undefined,
          email: pickCsvField(row, 'email') || undefined,
          phone: pickCsvField(row, 'phone', 'mobile') || undefined,
          address: pickCsvField(row, 'address') || undefined,
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
}

/** Boot/cron: seed default first-page supplier list caches. */
export async function warmDefaultSupplierListPages(
  prisma: import('@prisma/client').PrismaClient,
  cache: CacheService,
  tenantId: string,
): Promise<void> {
  await warmLegacyContactIdMap(prisma, cache, tenantId, 'supplier');
  for (const limit of [10, 25] as const) {
    for (const includeSummary of [false, true] as const) {
      const filterKey = listPageFilterKey({
        search: undefined,
        status: undefined,
        assignedToUserId: undefined,
        openingBalance: 0,
        purchaseDue: 0,
        purchaseReturn: 0,
        advanceBalance: 0,
        cursor: undefined,
        limit,
        sum: includeSummary ? 1 : 0,
      });
      await withListPageCache(
        cache,
        tenantId,
        'suppliers',
        filterKey,
        async () => {
          const baseWhere = { tenantId, deletedAt: null as null };
          const [rows, totalCount, amountAgg] = await Promise.all([
            prisma.supplier.findMany({
              where: baseWhere,
              include: { assignedToUser: { select: { name: true } } },
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              take: limit,
            }),
            includeSummary
              ? prisma.supplier.count({ where: baseWhere })
              : Promise.resolve(undefined as number | undefined),
            includeSummary
              ? prisma.supplier.aggregate({
                  where: baseWhere,
                  _sum: {
                    totalPurchase: true,
                    totalPurchaseDue: true,
                    totalPurchasePaid: true,
                  },
                })
              : Promise.resolve(undefined),
          ]);
          const legacyById = await getLegacyContactIdsForPage(
            prisma,
            cache,
            tenantId,
            'supplier',
            rows.map((row) => row.id),
          );
          const items = rows.map((row) =>
            toListRow(row, { contactId: legacyById.get(row.id) ?? null }),
          );
          if (!includeSummary || totalCount == null || amountAgg == null) {
            return { items };
          }
          return {
            items,
            totalCount,
            amountSummary: {
              totalAmount: toNumber(amountAgg._sum.totalPurchase),
              totalDue: toNumber(amountAgg._sum.totalPurchaseDue),
              totalPaid: toNumber(amountAgg._sum.totalPurchasePaid),
              currency: 'NGN',
            },
          };
        },
      );
    }
  }
}
