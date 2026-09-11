import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ContactDueSummary,
  ContactLedgerEntry,
  CreateCustomerInput,
  Customer,
  CustomerContactDetails,
  CustomerFilters,
  CustomerProfile,
  CustomerTransactionHistoryEntry,
  CustomerViewBundle,
  CsvImportResult,
  PayContactDueRequest,
  PayContactDueResult,
  UpdateCustomerInput,
} from '@vonos/types';
import { parseCustomerContactDetails } from '@vonos/types';
import { Prisma } from '@prisma/client';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache, invalidateTenantListCache } from '../../common/cache/cacheInvalidation';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import {
  HQ6_LIST_WARM_LIMITS,
} from '../../common/utils/hq6ListWarm';
import {
  getLegacyContactIdsForPage,
  warmLegacyContactIdMap,
} from '../../common/utils/legacyContactIdMap';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { resolveListSort } from '../../common/utils/listSort';
import type { PaginatedList } from '../../common/utils/paginatedList';
import { parseCsv, pickCsvField } from '../../common/utils/csvImport';
import { refreshCustomerFinancialRollups } from '../../common/utils/customerRollups';
import { recordPaymentAccountTxn } from '../../common/utils/recordPaymentAccountTxn';
import {
  contactTextSearchWhere,
  fetchCustomerFtsIds,
  shouldUseFtsListSearch,
} from '../../common/utils/listSearch';
import { toIso, toNumber } from '../../common/utils/serializers';
import { AuditService } from '../audit/audit.service';

/** Plate / Contact ID often embedded in legacy customer names (HQ6). */
function plateFromCustomerName(name: string | null | undefined): string | null {
  if (!name) return null;
  const m = name.match(/\b([A-Z]{1,4}-[A-Z0-9]{1,8})\b/i);
  return m?.[1]?.toUpperCase() ?? null;
}

/** Trim + upper-case the manually-entered Contact ID (vehicle reg. for VA). */
function normalizeContactId(
  details: CustomerContactDetails | null | undefined | unknown,
): string | null {
  if (!details || typeof details !== 'object') return null;
  const raw =
    typeof (details as CustomerContactDetails).contactId === 'string'
      ? (details as CustomerContactDetails).contactId!.trim()
      : '';
  return raw ? raw.toUpperCase() : null;
}

type SaleRow = {
  id?: string;
  reference?: string;
  total: string | number | { toString(): string } | null;
  currency?: string;
  status?: string;
  paymentStatus?: string | null;
  date?: Date;
  payments?: { amount: string | number | { toString(): string } | null }[];
};

function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

function saleTotals(sales: SaleRow[]) {
  let totalSell = 0;
  let totalSellDue = 0;
  let totalSellPaid = 0;
  let totalSellReturn = 0;
  for (const sale of sales) {
    const total = toNumber(sale.total);
    const paid = (sale.payments ?? []).reduce(
      (sum, p) => sum + toNumber(p.amount),
      0,
    );
    const isReturn =
      sale.status === 'refunded' ||
      sale.status === 'partially_refunded' ||
      sale.status === 'written_off';
    if (isReturn) {
      totalSellReturn += total;
    } else {
      totalSell += total;
      totalSellPaid += paid;
      if (sale.paymentStatus === 'due' || sale.paymentStatus === 'partial') {
        totalSellDue += Math.max(0, total - paid);
      }
    }
  }
  const totalAdvance = Math.max(0, totalSellPaid - totalSell);
  const visitCount = sales.filter(
    (sale) =>
      sale.status !== 'refunded' &&
      sale.status !== 'partially_refunded' &&
      sale.status !== 'written_off',
  ).length;
  return {
    totalSell,
    totalSellDue,
    totalSellPaid,
    totalSellReturn,
    totalAdvance,
    visitCount,
  };
}

function serializeCustomer(
  row: {
    id: string;
    tenantId: string;
    name: string;
    email: string | null;
    phone: string | null;
    customerGroupId?: string | null;
    customerGroup?: { name: string } | null;
    assignedToUserId?: string | null;
    assignedToUser?: { name: string } | null;
    openingBalance?: { toString(): string } | number | null;
    totalSell?: { toString(): string } | number | null;
    totalSellDue?: { toString(): string } | number | null;
    totalSellPaid?: { toString(): string } | number | null;
    totalSellReturn?: { toString(): string } | number | null;
    totalAdvance?: { toString(): string } | number | null;
    visitCount?: number | null;
    status?: string | null;
    taxNumber?: string | null;
    details?: unknown;
    createdByUserId: string | null;
    createdByName: string | null;
    createdAt: Date;
    updatedAt: Date;
    sales?: SaleRow[];
  },
  extras?: {
    contactId?: string | null;
    totalSell?: number;
    totalSellDue?: number;
    totalSellPaid?: number;
    totalSellReturn?: number;
    totalAdvance?: number;
    transactionHistory?: CustomerTransactionHistoryEntry[];
  },
): CustomerProfile {
  const sales = row.sales ?? [];
  const computed = sales.length > 0 ? saleTotals(sales) : null;
  const openingBalance = toNumber(row.openingBalance ?? 0);
  const storedTotalSell = row.totalSell != null ? toNumber(row.totalSell) : null;
  const storedVisitCount = row.visitCount ?? null;
  const details = parseCustomerContactDetails(row.details);

  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    customerGroupId: row.customerGroupId ?? null,
    customerGroupName: row.customerGroup?.name ?? null,
    assignedToUserId: row.assignedToUserId ?? null,
    assignedToName: row.assignedToUser?.name ?? null,
    openingBalance,
    totalSpend: storedTotalSell ?? computed?.totalSell ?? 0,
    visitCount: storedVisitCount ?? computed?.visitCount ?? 0,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    contactId:
      details.contactId?.trim() ||
      plateFromCustomerName(row.name) ||
      extras?.contactId ||
      row.id.slice(0, 8).toUpperCase(),
    businessName: details.businessName ?? null,
    taxNumber: row.taxNumber?.trim() || null,
    details,
    totalSell: extras?.totalSell ?? storedTotalSell ?? computed?.totalSell ?? 0,
    totalSellDue: extras?.totalSellDue ?? (row.totalSellDue != null ? toNumber(row.totalSellDue) : computed?.totalSellDue ?? 0),
    totalSellPaid: extras?.totalSellPaid ?? (row.totalSellPaid != null ? toNumber(row.totalSellPaid) : computed?.totalSellPaid ?? 0),
    totalSellReturn: extras?.totalSellReturn ?? (row.totalSellReturn != null ? toNumber(row.totalSellReturn) : computed?.totalSellReturn ?? 0),
    totalAdvance: extras?.totalAdvance ?? (row.totalAdvance != null ? toNumber(row.totalAdvance) : computed?.totalAdvance ?? 0),
    status: (row.status === 'inactive' ? 'inactive' : 'active') as
      | 'active'
      | 'inactive',
    transactionHistory: extras?.transactionHistory ?? [],
  };
}

function toDetailsJson(
  details: CustomerContactDetails | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (details === undefined) return undefined;
  if (details === null) return Prisma.JsonNull;
  return details as unknown as Prisma.InputJsonValue;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly auditService: AuditService,
    private readonly cache: CacheService,
  ) {}

  async list(filters: CustomerFilters): Promise<PaginatedList<Customer>> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      status: filters.status,
      customerGroupId: filters.customerGroupId,
      assignedToUserId: filters.assignedToUserId,
      assignedToEmployeeId: filters.assignedToEmployeeId,
      openingBalance: filters.openingBalance ? 1 : 0,
      sellDue: filters.sellDue ? 1 : 0,
      advanceBalance: filters.advanceBalance ? 1 : 0,
      sellReturn: filters.sellReturn ? 1 : 0,
      hasNoSellMonths: filters.hasNoSellMonths,
      from: filters.from,
      to: filters.to,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortBy: filters.sortBy ?? 'updatedAt',
      sortDir: filters.sortDir ?? 'desc',
      sum: filters.includeSummary === false ? 0 : 1,
      lite: filters.lite ? 1 : 0,
    });

    return withListPageCache(
      this.cache,
      tenantId,
      'customers',
      filterKey,
      () => this.listUncached(filters, tenantId),
    );
  }

  private async listUncached(
    filters: CustomerFilters,
    tenantId: string,
  ): Promise<PaginatedList<Customer>> {
    const sinceCutoff =
      filters.hasNoSellMonths != null
        ? monthsAgo(filters.hasNoSellMonths)
        : null;
    const sort = resolveListSort(
      filters.sortBy,
      filters.sortDir,
      {
        createdAt: { field: 'createdAt', type: 'date' },
        updatedAt: { field: 'updatedAt', type: 'date' },
        name: { field: 'name', type: 'string' },
        email: { field: 'email', type: 'string' },
        phone: { field: 'phone', type: 'string' },
        totalSellDue: { field: 'totalSellDue', type: 'number' },
        totalSell: { field: 'totalSell', type: 'number' },
        openingBalance: { field: 'openingBalance', type: 'number' },
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
      limit: filters.limit ?? 10,
      sortValueType: sort.sortValueType,
    });

    const baseWhere = {
      tenantId,
      deletedAt: null,
      ...(filters.customerGroupId
        ? { customerGroupId: filters.customerGroupId }
        : {}),
      ...(filters.assignedToUserId
        ? { assignedToUserId: filters.assignedToUserId }
        : {}),
      ...(filters.assignedToEmployeeId
        ? {
            details: {
              path: ['assignedToEmployeeId'],
              equals: filters.assignedToEmployeeId,
            },
          }
        : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.openingBalance ? { openingBalance: { gt: 0 } } : {}),
      ...(filters.sellDue ? { totalSellDue: { gt: 0 } } : {}),
      ...(filters.advanceBalance ? { totalAdvance: { gt: 0 } } : {}),
      ...(filters.sellReturn ? { totalSellReturn: { gt: 0 } } : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
      // Phone / single-token → prefix/trigram; multi-word → FTS candidates.
      ...(await (async () => {
        if (!filters.search) return {};
        if (shouldUseFtsListSearch(filters.search)) {
          const ftsIds = await fetchCustomerFtsIds(
            this.tenantDb.db,
            tenantId,
            filters.search,
          );
          if (ftsIds.length > 0) return { id: { in: ftsIds } };
        }
        return contactTextSearchWhere(filters.search) ?? {};
      })()),
      ...(sinceCutoff
        ? {
            NOT: {
              sales: {
                some: {
                  deletedAt: null,
                  status: 'completed' as const,
                  date: { gte: sinceCutoff },
                },
              },
            },
          }
        : {}),
    };

    // Rows first; legacy IDs from warm map (0 RTT) or page-scoped IN (1 RTT).
    // Skip Redis/Neon when every row already has Contact ID in details JSON.
    const includeSummary = filters.includeSummary !== false;
    const [rows, totalCount, amountAgg] = await Promise.all([
      this.tenantDb.db.customer.findMany({
        where: {
          ...baseWhere,
          ...(pagination.where ?? {}),
        },
        // List projection only — avoid full Customer + relation payloads.
        select: {
          id: true,
          tenantId: true,
          name: true,
          email: true,
          phone: true,
          customerGroupId: true,
          assignedToUserId: true,
          openingBalance: true,
          totalSell: true,
          totalSellDue: true,
          totalSellPaid: true,
          totalSellReturn: true,
          totalAdvance: true,
          visitCount: true,
          status: true,
          taxNumber: true,
          createdByUserId: true,
          createdByName: true,
          createdAt: true,
          updatedAt: true,
          details: true,
          customerGroup: { select: { name: true } },
          assignedToUser: { select: { name: true } },
        },
        orderBy: [{ [sort.sortField]: sort.sortDir }, { id: sort.sortDir }],
        take: pagination.take,
      }),
      includeSummary
        ? this.tenantDb.db.customer.count({ where: baseWhere })
        : Promise.resolve(undefined as number | undefined),
      includeSummary
        ? this.tenantDb.db.customer.aggregate({
            where: baseWhere,
            _sum: {
              totalSell: true,
              totalSellDue: true,
              totalSellPaid: true,
            },
          })
        : Promise.resolve(undefined),
    ]);

    // Typeahead pickers render the name only — skip the legacy Contact ID
    // resolution round-trip entirely.
    let legacyById = new Map<string, string>();
    if (!filters.lite) {
      const missingIds = rows
        .filter((row) => !normalizeContactId(row.details))
        .map((row) => row.id);
      if (missingIds.length > 0) {
        legacyById = await getLegacyContactIdsForPage(
          this.tenantDb.db,
          this.cache,
          tenantId,
          'customer',
          missingIds,
        );
      }
    }

    const items = rows.map((row) =>
      serializeCustomer(row, { contactId: legacyById.get(row.id) ?? null }),
    );

    if (!includeSummary || totalCount == null || amountAgg == null) {
      return { items };
    }

    // Trust denormalized totals on list (refreshed on sale write). Live sale scans
    // per page were ~20s on Neon and stampeded the pool.
    return {
      items,
      totalCount,
      amountSummary: {
        totalAmount: toNumber(amountAgg._sum.totalSell),
        totalPaid: toNumber(amountAgg._sum.totalSellPaid),
        totalDue: toNumber(amountAgg._sum.totalSellDue),
        currency: 'NGN',
      },
    };
  }

  /** Reject a duplicate Contact ID (vehicle registration) within the tenant. */
  private async assertContactIdUnique(
    tenantId: string,
    contactId: string,
    excludeId?: string,
  ): Promise<void> {
    const dup = await this.tenantDb.db.customer.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        details: { path: ['contactId'], equals: contactId },
      },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException(
        `A customer with Contact ID ${contactId} already exists`,
      );
    }
  }

  /**
   * Validate the assigned HRM employee (worker) belongs to the tenant and stamp
   * the authoritative name onto `details`. Clears both fields when unset.
   */
  private async resolveAssignedEmployee(
    tenantId: string,
    details: CustomerContactDetails | null | undefined,
  ): Promise<void> {
    if (!details || typeof details !== 'object') return;
    const employeeId =
      typeof details.assignedToEmployeeId === 'string'
        ? details.assignedToEmployeeId.trim()
        : '';
    if (!employeeId) {
      details.assignedToEmployeeId = null;
      details.assignedToEmployeeName = null;
      return;
    }
    const employee = await this.tenantDb.db.employee.findFirst({
      where: { id: employeeId, tenantId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!employee) {
      throw new BadRequestException('Assigned worker not found');
    }
    details.assignedToEmployeeId = employee.id;
    details.assignedToEmployeeName = employee.name;
  }

  async create(dto: CreateCustomerInput): Promise<Customer> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Customer name is required');
    }
    const createdBy = await this.auditService.createdByFields();
    const parsedDetails = dto.details
      ? parseCustomerContactDetails(dto.details)
      : dto.details;
    const contactId = normalizeContactId(parsedDetails);
    if (parsedDetails && typeof parsedDetails === 'object') {
      parsedDetails.contactId = contactId;
    }
    // Uniqueness + assignee in parallel when both needed.
    await Promise.all([
      contactId
        ? this.assertContactIdUnique(tenantId, contactId)
        : Promise.resolve(),
      this.resolveAssignedEmployee(tenantId, parsedDetails),
    ]);
    const detailsJson = toDetailsJson(parsedDetails);
    const row = await this.tenantDb.db.customer.create({
      data: {
        tenantId,
        name,
        email: dto.email?.trim() || null,
        phone: dto.phone?.trim() || null,
        customerGroupId: dto.customerGroupId?.trim() || null,
        assignedToUserId: dto.assignedToUserId?.trim() || null,
        openingBalance: dto.openingBalance ?? 0,
        status: dto.status ?? 'active',
        taxNumber: dto.taxNumber?.trim() || null,
        ...(detailsJson !== undefined ? { details: detailsJson } : {}),
        ...createdBy,
      },
      include: {
        customerGroup: { select: { name: true } },
        assignedToUser: { select: { name: true } },
      },
    });
    void this.auditService.log({
      action: 'created',
      entityType: 'customer',
      entityId: row.id,
      summary: `Created customer ${row.name}`,
    });
    void invalidateTenantListCache(this.cache, tenantId, ['customers']);
    return serializeCustomer({ ...row, sales: [] });
  }

  async update(id: string, dto: UpdateCustomerInput): Promise<Customer> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Customer not found');

    const name = dto.name?.trim();
    if (dto.name !== undefined && !name) {
      throw new BadRequestException('Customer name is required');
    }

    const parsedDetails =
      dto.details === undefined
        ? undefined
        : dto.details
          ? parseCustomerContactDetails(dto.details)
          : null;
    if (parsedDetails && typeof parsedDetails === 'object') {
      const contactId = normalizeContactId(parsedDetails);
      parsedDetails.contactId = contactId;
      await Promise.all([
        contactId
          ? this.assertContactIdUnique(tenantId, contactId, id)
          : Promise.resolve(),
        this.resolveAssignedEmployee(tenantId, parsedDetails),
      ]);
    }
    const detailsJson = toDetailsJson(parsedDetails);

    const row = await this.tenantDb.db.customer.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(dto.email !== undefined ? { email: dto.email?.trim() || null } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone?.trim() || null } : {}),
        ...(dto.customerGroupId !== undefined
          ? { customerGroupId: dto.customerGroupId?.trim() || null }
          : {}),
        ...(dto.assignedToUserId !== undefined
          ? { assignedToUserId: dto.assignedToUserId?.trim() || null }
          : {}),
        ...(dto.openingBalance !== undefined
          ? { openingBalance: dto.openingBalance }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.taxNumber !== undefined
          ? { taxNumber: dto.taxNumber?.trim() || null }
          : {}),
        ...(detailsJson !== undefined ? { details: detailsJson } : {}),
      },
      include: {
        customerGroup: { select: { name: true } },
        assignedToUser: { select: { name: true } },
      },
    });
    void this.auditService.log({
      action: 'updated',
      entityType: 'customer',
      entityId: id,
      summary: `Updated customer ${row.name}`,
    });
    void invalidateTenantListCache(this.cache, tenantId, ['customers']);
    return serializeCustomer({ ...row, sales: [] });
  }

  async setStatus(
    id: string,
    status: 'active' | 'inactive',
  ): Promise<Customer> {
    return this.update(id, { status });
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Customer not found');
    await this.tenantDb.db.customer.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.auditService.log({
      action: 'deleted',
      entityType: 'customer',
      entityId: id,
      summary: `Deleted customer ${existing.name}`,
    });
    void invalidateTenantListCache(this.cache, tenantId, ['customers']);
  }

  /** Apply a contact payment across oldest due/partial sales (HQ6 pay-contact-due). */
  async payDue(
    id: string,
    dto: PayContactDueRequest,
  ): Promise<PayContactDueResult> {
    const tenantId = this.tenantDb.requireTenantId();
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Payment amount must be greater than zero');
    }
    const accountId = dto.accountId?.trim() || null;
    if (!accountId) {
      throw new BadRequestException(
        'Select a Payment Account so this payment posts to the account book',
      );
    }

    const customer = await this.tenantDb.db.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const openSales = await this.tenantDb.db.sale.findMany({
      where: {
        tenantId,
        customerId: id,
        deletedAt: null,
        paymentStatus: { in: ['due', 'partial'] },
        status: { notIn: ['draft', 'quotation', 'refunded', 'written_off'] },
      },
      include: {
        payments: { where: { deletedAt: null }, select: { amount: true } },
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });

    if (openSales.length === 0) {
      throw new BadRequestException('No outstanding sales due for this customer');
    }

    let remaining = amount;
    let paymentsCreated = 0;
    const paidOn = dto.paidOn ? new Date(dto.paidOn) : new Date();
    const method = dto.method?.trim() || 'cash';
    const createdBy = await this.auditService.createdByFields();

    await this.tenantDb.db.$transaction(async (tx) => {
      for (const sale of openSales) {
        if (remaining <= 0) break;
        const total = toNumber(sale.total);
        const paid = sale.payments.reduce(
          (sum, payment) => sum + toNumber(payment.amount),
          0,
        );
        const due = Math.max(0, total - paid);
        if (due <= 0) continue;

        const apply = Math.min(remaining, due);
        const payment = await tx.payment.create({
          data: {
            tenantId,
            amount: apply,
            currency: sale.currency || 'NGN',
            method,
            paidOn,
            paymentFor: 'sale',
            saleId: sale.id,
            accountId,
            note: dto.note?.trim() || `Contact payment — ${customer.name}`,
            createdByName: createdBy.createdByName ?? null,
          },
        });

        await recordPaymentAccountTxn(tx, {
          tenantId,
          accountId,
          type: 'credit',
          subType: 'sale_payment',
          amount: apply,
          operationDate: paidOn,
          refNo: sale.reference,
          note: dto.note?.trim() || `Contact payment — ${customer.name}`,
          paymentMethod: method,
          saleId: sale.id,
          paymentId: payment.id,
          createdByName: createdBy.createdByName ?? null,
        });

        const newPaid = paid + apply;
        const paymentStatus =
          newPaid >= total - 0.001 ? 'paid' : newPaid > 0 ? 'partial' : 'due';
        await tx.sale.update({
          where: { id: sale.id },
          data: { paymentStatus },
        });

        remaining -= apply;
        paymentsCreated += 1;
      }
    });

    if (paymentsCreated === 0) {
      throw new BadRequestException('No outstanding balance could be applied');
    }

    await refreshCustomerFinancialRollups(this.tenantDb.db, id);
    void invalidateTenantDashboardCache(this.cache, tenantId);
    const summary = await this.getSummary(id);
    await this.auditService.log({
      action: 'updated',
      entityType: 'customer',
      entityId: id,
      summary: `Recorded payment of ${amount - remaining} for ${customer.name}`,
    });

    return {
      contactId: id,
      amountApplied: amount - remaining,
      currency: summary.currency,
      paymentsCreated,
      remainingDue: summary.totalDue,
    };
  }

  /**
   * Profile shell — denormalized totals only (fast).
   * Pass `includeHistory: true` (or call getHistory) for sales/jobs/appointments.
   */
  async getById(
    id: string,
    opts: { includeHistory?: boolean } = {},
  ): Promise<CustomerProfile> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        customerGroup: { select: { name: true } },
        assignedToUser: { select: { name: true } },
      },
    });
    if (!row) throw new NotFoundException('Customer not found');

    if (!opts.includeHistory) {
      return serializeCustomer(row, { transactionHistory: [] });
    }

    const history = await this.getHistory(id);
    return serializeCustomer(row, { transactionHistory: history });
  }

  /** Sales / jobs / appointments feed for customer profile tabs. */
  async getHistory(id: string): Promise<CustomerTransactionHistoryEntry[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Customer not found');

    const [sales, jobs, appointments] = await Promise.all([
      this.tenantDb.db.sale.findMany({
        where: { customerId: id, tenantId, deletedAt: null },
        select: {
          id: true,
          reference: true,
          total: true,
          currency: true,
          status: true,
          paymentStatus: true,
          date: true,
        },
        orderBy: { date: 'desc' },
        take: 100,
      }),
      this.tenantDb.db.job.findMany({
        where: { customerId: id, tenantId, deletedAt: null },
        select: {
          id: true,
          reference: true,
          status: true,
          invoiceAmount: true,
          quoteAmount: true,
          dueDate: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.tenantDb.db.appointment.findMany({
        where: { customerId: id, tenantId, deletedAt: null },
        select: {
          id: true,
          serviceName: true,
          servicePrice: true,
          currency: true,
          status: true,
          startTime: true,
        },
        orderBy: { startTime: 'desc' },
        take: 50,
      }),
    ]);

    return [
      ...sales.map((sale) => ({
        id: sale.id,
        kind: 'sale' as const,
        reference: sale.reference,
        date: toIso(sale.date),
        amount: toNumber(sale.total),
        currency: sale.currency,
        status: sale.status,
        paymentStatus: sale.paymentStatus,
      })),
      ...jobs.map((job) => ({
        id: job.id,
        kind: 'job' as const,
        reference: job.reference,
        date: toIso(job.dueDate ?? job.createdAt),
        amount: toNumber(job.invoiceAmount ?? job.quoteAmount ?? 0),
        currency: 'NGN',
        status: job.status,
        paymentStatus: null,
      })),
      ...appointments.map((appt) => ({
        id: appt.id,
        kind: 'appointment' as const,
        reference: appt.serviceName,
        date: toIso(appt.startTime),
        amount: toNumber(appt.servicePrice),
        currency: appt.currency,
        status: appt.status,
        paymentStatus: null,
      })),
    ].sort((a, b) => b.date.localeCompare(a.date));
  }

  async getContact(id: string): Promise<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    totalSellDue: number;
    totalAdvance: number;
    visitCount: number;
    createdAt: string;
    status: 'active' | 'inactive';
    contactId: string | null;
    businessName: string | null;
    details: CustomerContactDetails | null;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        totalSellDue: true,
        totalAdvance: true,
        visitCount: true,
        createdAt: true,
        status: true,
        details: true,
      },
    });
    if (!row) throw new NotFoundException('Customer not found');
    const details = parseCustomerContactDetails(row.details);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      totalSellDue: toNumber(row.totalSellDue),
      totalAdvance: toNumber(row.totalAdvance),
      visitCount: row.visitCount,
      createdAt: toIso(row.createdAt),
      status: row.status === 'inactive' ? 'inactive' : 'active',
      contactId: details.contactId ?? null,
      businessName: details.businessName ?? null,
      details,
    };
  }

  /** Modal bundle: contact + summary + ledger (sequential DB / nested awaits). */
  async getView(id: string): Promise<CustomerViewBundle> {
    const customer = await this.getContact(id);
    const summary = await this.getSummary(id);
    const ledger = await this.getLedger(id);
    return { customer, summary, ledger };
  }

  async getSummary(id: string): Promise<ContactDueSummary> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        id: true,
        totalSell: true,
        totalSellPaid: true,
        totalSellDue: true,
      },
    });
    if (!row) throw new NotFoundException('Customer not found');
    return {
      contactId: row.id,
      totalAmount: toNumber(row.totalSell),
      totalPaid: toNumber(row.totalSellPaid),
      totalDue: toNumber(row.totalSellDue),
      currency: 'NGN',
    };
  }

  async getLedger(
    id: string,
    cursor?: string,
    limit = 50,
  ): Promise<ContactLedgerEntry[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const customer = await this.tenantDb.db.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const sales = await this.tenantDb.db.sale.findMany({
      where: { tenantId, customerId: id, deletedAt: null },
      select: { id: true, reference: true },
    });
    const saleIds = sales.map((sale) => sale.id);
    const saleRefById = new Map(sales.map((sale) => [sale.id, sale.reference]));

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
        OR: [
          { linkedRecordType: 'sale', linkedRecordId: { in: saleIds } },
          {
            linkedRecordType: 'payment',
            linkedRecordId: {
              in: (
                await this.tenantDb.db.payment.findMany({
                  where: { tenantId, saleId: { in: saleIds }, deletedAt: null },
                  select: { id: true },
                })
              ).map((payment) => payment.id),
            },
          },
        ],
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
        entry.linkedRecordType === 'sale' && entry.linkedRecordId
          ? (saleRefById.get(entry.linkedRecordId) ?? null)
          : null,
    }));
  }

  async importCsv(csv: string): Promise<CsvImportResult> {
    const rows = parseCsv(csv);
    const result: CsvImportResult = { created: 0, updated: 0, errors: [] };

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = pickCsvField(row, 'name', 'business name', 'customer name');
      if (!name) {
        result.errors.push({ row: index + 2, message: 'Name is required' });
        continue;
      }
      try {
        await this.create({
          name,
          email: pickCsvField(row, 'email') || undefined,
          phone: pickCsvField(row, 'phone', 'mobile', 'contact number') || undefined,
          taxNumber:
            pickCsvField(row, 'tax number', 'tax_number', 'vat', 'tin') ||
            undefined,
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

/** Boot/cron: seed HQ6 default first-page customer list caches. */
export async function warmDefaultCustomerListPages(
  prisma: import('@prisma/client').PrismaClient,
  cache: CacheService,
  tenantId: string,
): Promise<void> {
  await warmLegacyContactIdMap(prisma, cache, tenantId, 'customer');
  for (const limit of HQ6_LIST_WARM_LIMITS) {
    for (const includeSummary of [false, true] as const) {
      // Keys must match CustomersService.list filterKey (incl. lite + employee).
      const filterKey = listPageFilterKey({
        search: undefined,
        status: undefined,
        customerGroupId: undefined,
        assignedToUserId: undefined,
        assignedToEmployeeId: undefined,
        openingBalance: 0,
        sellDue: 0,
        advanceBalance: 0,
        sellReturn: 0,
        hasNoSellMonths: undefined,
        from: undefined,
        to: undefined,
        cursor: undefined,
        limit,
        sortBy: 'updatedAt',
        sortDir: 'desc',
        sum: includeSummary ? 1 : 0,
        lite: 0,
      });
      await withListPageCache(
        cache,
        tenantId,
        'customers',
        filterKey,
        async () => {
          const baseWhere = { tenantId, deletedAt: null };
          const [rows, totalCount, amountAgg] = await Promise.all([
            prisma.customer.findMany({
              where: baseWhere,
              include: {
                customerGroup: { select: { name: true } },
                assignedToUser: { select: { name: true } },
              },
              orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
              take: limit,
            }),
            includeSummary
              ? prisma.customer.count({ where: baseWhere })
              : Promise.resolve(undefined as number | undefined),
            includeSummary
              ? prisma.customer.aggregate({
                  where: baseWhere,
                  _sum: {
                    totalSell: true,
                    totalSellDue: true,
                    totalSellPaid: true,
                  },
                })
              : Promise.resolve(undefined),
          ]);
          const legacyById = await getLegacyContactIdsForPage(
            prisma,
            cache,
            tenantId,
            'customer',
            rows.map((row) => row.id),
          );
          const items = rows.map((row) =>
            serializeCustomer(row, {
              contactId: legacyById.get(row.id) ?? null,
            }),
          );
          if (!includeSummary || totalCount == null || amountAgg == null) {
            return { items };
          }
          return {
            items,
            totalCount,
            amountSummary: {
              totalAmount: toNumber(amountAgg._sum.totalSell),
              totalPaid: toNumber(amountAgg._sum.totalSellPaid),
              totalDue: toNumber(amountAgg._sum.totalSellDue),
              currency: 'NGN',
            },
          };
        },
        600,
      );
    }
  }
}
