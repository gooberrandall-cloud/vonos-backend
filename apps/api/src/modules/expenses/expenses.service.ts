import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  Expense,
  ExpenseCategory,
  CreateExpenseRequest,
  CreateExpenseCategoryRequest,
  UpdateExpenseRequest,
  PayContactDueRequest,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { applyDailyFinanceDelta } from '../../common/utils/dailyFinanceRollup';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import {
  HQ6_LIST_WARM_LIMITS,
} from '../../common/utils/hq6ListWarm';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import type { PaginatedList } from '../../common/utils/paginatedList';
import { paymentStatusFromAmounts } from '../../common/utils/paymentStatus';
import { toIso, toNumber } from '../../common/utils/serializers';
import { InvoiceHubService } from '../invoices/invoice-hub.service';
import { AuditService } from '../audit/audit.service';
import { expenseTextSearchWhere } from '../../common/utils/listSearch';
import {
  softDeleteExpenseAccountTxns,
  syncExpenseAccountDebit,
} from '../../common/utils/recordPaymentAccountTxn';

type ExpenseRow = {
  id: string;
  tenantId: string;
  refNo: string | null;
  categoryId: string | null;
  subCategory: string | null;
  locationCode: string | null;
  expenseForCustomerId: string | null;
  expenseFor: string | null;
  contactCustomerId: string | null;
  contactName: string | null;
  totalAmount: import('@prisma/client').Prisma.Decimal;
  taxAmount: import('@prisma/client').Prisma.Decimal;
  paymentStatus: string;
  paymentDue: import('@prisma/client').Prisma.Decimal;
  note: string | null;
  accountId: string | null;
  isRecurring: boolean;
  recurInterval: number | null;
  recurIntervalType: string | null;
  expenseDate: Date;
  createdById: string | null;
  createdByName?: string | null;
  createdAt: Date;
  updatedAt: Date;
  category?: { name: string } | null;
  expenseForCustomer?: { name: string } | null;
  contactCustomer?: { name: string } | null;
  account?: { name: string } | null;
};

const expenseInclude = {
  category: { select: { id: true, name: true } },
  expenseForCustomer: { select: { name: true } },
  contactCustomer: { select: { name: true } },
  account: { select: { name: true } },
} as const;

type ExpenseLedgerDb = Prisma.TransactionClient | Prisma.DefaultPrismaClient;

async function upsertExpenseLedgerEntry(
  db: ExpenseLedgerDb,
  params: {
    tenantId: string;
    expenseId: string;
    amount: number;
    category: string;
    description: string;
    date: Date;
  },
): Promise<void> {
  const existing = await db.ledgerEntry.findFirst({
    where: {
      tenantId: params.tenantId,
      linkedRecordType: 'expense',
      linkedRecordId: params.expenseId,
      deletedAt: null,
    },
    select: { id: true },
  });
  const category = params.category.trim() || 'Expense';
  const description = params.description.trim() || category;
  if (existing) {
    await db.ledgerEntry.update({
      where: { id: existing.id },
      data: {
        amount: params.amount,
        category,
        description,
        date: params.date,
      },
    });
    return;
  }
  await db.ledgerEntry.create({
    data: {
      tenantId: params.tenantId,
      type: 'expense',
      amount: params.amount,
      currency: 'NGN',
      category,
      description,
      linkedRecordType: 'expense',
      linkedRecordId: params.expenseId,
      date: params.date,
    },
  });
}

function settleExpensePayment(input: {
  total: number;
  paymentDue?: number;
  accountId: string | null;
  previousStatus?: string | null;
}): {
  paymentStatus: 'paid' | 'partial' | 'due' | 'overdue';
  paymentDue: number;
  paidAmount: number;
} {
  const total = Math.max(0, Number.isFinite(input.total) ? input.total : 0);
  const due =
    input.paymentDue !== undefined
      ? Math.max(0, Math.min(total, Number(input.paymentDue) || 0))
      : input.accountId
        ? 0
        : total;
  const paidAmount = Math.max(0, total - due);
  if (paidAmount > 1e-6 && !input.accountId) {
    throw new BadRequestException(
      'Select a Payment Account so this expense payment posts to the account book',
    );
  }
  return {
    paymentStatus: paymentStatusFromAmounts(
      total,
      paidAmount,
      input.previousStatus,
    ),
    paymentDue: due,
    paidAmount,
  };
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly invoiceHub: InvoiceHubService,
    private readonly cache: CacheService,
    private readonly auditService: AuditService,
  ) {}

  async listExpenses(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    from?: string;
    to?: string;
    locationCode?: string;
    expenseForCustomerId?: string;
    contactCustomerId?: string;
    createdById?: string;
    categoryId?: string;
    paymentStatus?: string;
    includeSummary?: boolean;
  } = {}): Promise<PaginatedList<Expense>> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      from: filters.from,
      to: filters.to,
      locationCode: filters.locationCode,
      expenseForCustomerId: filters.expenseForCustomerId,
      contactCustomerId: filters.contactCustomerId,
      createdById: filters.createdById,
      categoryId: filters.categoryId,
      paymentStatus: filters.paymentStatus,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sum: filters.includeSummary === false ? 0 : 1,
    });

    return withListPageCache(
      this.cache,
      tenantId,
      'expenses',
      filterKey,
      () => this.listExpensesUncached(filters, tenantId),
    );
  }

  private async listExpensesUncached(
    filters: {
      cursor?: string;
      limit?: number;
      search?: string;
      from?: string;
      to?: string;
      locationCode?: string;
      expenseForCustomerId?: string;
      contactCustomerId?: string;
      createdById?: string;
      categoryId?: string;
      paymentStatus?: string;
      includeSummary?: boolean;
    },
    tenantId: string,
  ): Promise<PaginatedList<Expense>> {
    const dateFilter =
      filters.from || filters.to
        ? {
            expenseDate: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {};
    const pagination = buildCompositeCursorQuery({
      sortField: 'updatedAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const baseWhere = {
      tenantId,
      deletedAt: null as null,
      ...dateFilter,
      ...(filters.locationCode
        ? { locationCode: filters.locationCode }
        : {}),
      ...(filters.expenseForCustomerId
        ? { expenseForCustomerId: filters.expenseForCustomerId }
        : {}),
      ...(filters.contactCustomerId
        ? { contactCustomerId: filters.contactCustomerId }
        : {}),
      ...(filters.createdById ? { createdById: filters.createdById } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.paymentStatus === 'paid'
        ? {
            OR: [
              { paymentStatus: 'paid' },
              {
                AND: [
                  { paymentStatus: 'due' },
                  { accountId: { not: null } },
                ],
              },
            ],
          }
        : filters.paymentStatus === 'due'
          ? { paymentStatus: 'due', accountId: null }
          : filters.paymentStatus
            ? { paymentStatus: filters.paymentStatus }
            : {}),
      ...(expenseTextSearchWhere(filters.search) ?? {}),
    };
    const rows = await this.tenantDb.db.expense.findMany({
      where: {
        ...baseWhere,
        ...(pagination.where ?? {}),
      },
      include: expenseInclude,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });

    const userIds = [
      ...new Set(
        rows
          .filter((r) => !r.createdByName && r.createdById)
          .map((r) => r.createdById)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const users =
      userIds.length > 0
        ? await this.tenantDb.db.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true },
          })
        : [];
    const userNames = new Map(users.map((u) => [u.id, u.name]));
    const items = rows.map((row) =>
      this.serializeExpense(
        row,
        row.createdByName ??
          userNames.get(row.createdById ?? '') ??
          null,
      ),
    );

    if (filters.includeSummary === false) {
      return { items };
    }

    const [totalCount, amountAgg, dueAgg] = await Promise.all([
      this.tenantDb.db.expense.count({ where: baseWhere }),
      this.tenantDb.db.expense.aggregate({
        where: baseWhere,
        _sum: { totalAmount: true },
      }),
      this.tenantDb.db.expense.aggregate({
        where: {
          ...baseWhere,
          paymentStatus: 'due',
          accountId: null,
        },
        _sum: { paymentDue: true },
      }),
    ]);

    return {
      items,
      totalCount,
      amountSummary: {
        totalAmount: toNumber(amountAgg._sum.totalAmount),
        totalDue: toNumber(dueAgg._sum.paymentDue),
        currency: 'NGN',
      },
    };
  }

  async createExpense(dto: CreateExpenseRequest): Promise<Expense> {
    const tenantId = this.tenantDb.requireTenantId();
    const accountId = dto.accountId?.trim() || null;
    const settled = settleExpensePayment({
      total: Number(dto.totalAmount),
      paymentDue: dto.paymentDue,
      accountId,
      previousStatus: dto.paymentStatus,
    });
    const { paymentStatus, paymentDue, paidAmount } = settled;
    const shouldDebit = Boolean(accountId) && paidAmount > 0;

    const authUserId = this.tenantDb.getAuthUserId();
    const createdBy = await this.auditService.createdByFields();
    const createdByName = createdBy.createdByName ?? null;

    const expenseData = {
      tenantId,
      categoryId: dto.categoryId ?? null,
      refNo: dto.refNo ?? null,
      subCategory: dto.subCategory ?? null,
      locationCode: dto.locationCode ?? null,
      expenseForCustomerId: dto.expenseForCustomerId ?? null,
      contactCustomerId: dto.contactCustomerId ?? null,
      expenseFor: dto.expenseFor ?? null,
      contactName: dto.contactName ?? null,
      totalAmount: dto.totalAmount,
      taxAmount: dto.taxAmount ?? 0,
      paymentStatus,
      paymentDue,
      note: dto.note ?? null,
      accountId,
      isRecurring: dto.isRecurring ?? false,
      recurInterval: dto.recurInterval ?? null,
      recurIntervalType: dto.recurIntervalType ?? null,
      expenseDate: dto.expenseDate ? new Date(dto.expenseDate) : new Date(),
      createdById: authUserId ?? createdBy.createdByUserId ?? null,
      createdByName,
    };

    // Due / unpaid with no account debit: single insert, no interactive tx.
    // Paid+debit still needs atomic expense + account transaction.
    const row = shouldDebit
      ? await this.tenantDb.db.$transaction(async (tx) => {
          const created = await tx.expense.create({
            data: expenseData,
            include: expenseInclude,
          });
          await syncExpenseAccountDebit(tx, {
            tenantId,
            expenseId: created.id,
            accountId: accountId!,
            amount: paidAmount,
            operationDate: created.expenseDate,
            refNo: created.refNo,
            note:
              dto.paymentNote?.trim() ||
              dto.note ||
              `Expense — ${created.refNo ?? created.id}`,
            paymentMethod: dto.paymentMethod ?? null,
          });
          await upsertExpenseLedgerEntry(tx, {
            tenantId,
            expenseId: created.id,
            amount: dto.totalAmount,
            category: created.category?.name ?? created.subCategory ?? 'Expense',
            description:
              created.note?.trim() ||
              created.refNo ||
              `Expense ${created.id.slice(-8)}`,
            date: created.expenseDate,
          });
          return created;
        })
      : await this.tenantDb.db.expense.create({
          data: expenseData,
          include: expenseInclude,
        });
    if (!shouldDebit) {
      void upsertExpenseLedgerEntry(this.tenantDb.db, {
        tenantId,
        expenseId: row.id,
        amount: dto.totalAmount,
        category: row.category?.name ?? row.subCategory ?? 'Expense',
        description:
          row.note?.trim() || row.refNo || `Expense ${row.id.slice(-8)}`,
        date: row.expenseDate,
      }).catch((err: unknown) => {
        console.error('[expenses] ledger upsert failed', err);
      });
    }

    // Defer invoice + rollup so concurrent creates aren't serialized on extra
    // round-trips (bench: 15 writers were ~22s with awaited invoice hub).
    void this.invoiceHub
      .ensureExpenseInvoice(this.tenantDb.db, row)
      .catch((err: unknown) => {
        console.error('[expenses] ensureExpenseInvoice failed', err);
      });
    void applyDailyFinanceDelta(
      this.tenantDb.db,
      tenantId,
      row.expenseDate,
      'expense',
      toNumber(row.totalAmount),
    ).catch((err: unknown) => {
      console.error('[expenses] daily finance rollup failed', err);
    });
    this.invalidateCaches();
    void this.auditService.log({
      action: 'created',
      entityType: 'expense',
      entityId: row.id,
      summary: `Created expense ${row.refNo?.trim() || row.id.slice(-8)}`,
      metadata: {
        totalAmount: toNumber(row.totalAmount),
        paymentStatus: row.paymentStatus,
        category: row.category?.name ?? null,
      },
    });
    return this.serializeExpense(row, row.createdByName ?? null);
  }

  private invalidateCaches(): void {
    void invalidateTenantDashboardCache(
      this.cache,
      this.tenantDb.requireTenantId(),
    );
  }

  async getExpenseById(id: string): Promise<Expense> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.expense.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: expenseInclude,
    });
    if (!row) throw new NotFoundException('Expense not found');

    let createdByName: string | null = row.createdByName ?? null;
    if (!createdByName && row.createdById) {
      const user = await this.tenantDb.db.user.findFirst({
        where: { id: row.createdById },
        select: { name: true },
      });
      createdByName = user?.name ?? null;
    }
    const debit = await this.tenantDb.db.accountTransaction.findFirst({
      where: {
        tenantId,
        expenseId: id,
        deletedAt: null,
        type: 'debit',
        subType: 'expense',
      },
      orderBy: { createdAt: 'desc' },
      select: { paymentMethod: true },
    });
    return this.serializeExpense(
      row,
      createdByName,
      debit?.paymentMethod ?? null,
    );
  }

  async updateExpense(id: string, dto: UpdateExpenseRequest): Promise<Expense> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.expense.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Expense not found');

    const updatedTotal =
      dto.totalAmount !== undefined
        ? dto.totalAmount
        : toNumber(existing.totalAmount);
    const accountId =
      dto.accountId !== undefined
        ? dto.accountId || null
        : existing.accountId;
    const settled = settleExpensePayment({
      total: updatedTotal,
      paymentDue:
        dto.paymentDue !== undefined
          ? dto.paymentDue
          : dto.accountId !== undefined && !accountId
            ? updatedTotal
            : toNumber(existing.paymentDue),
      accountId,
      previousStatus: dto.paymentStatus ?? existing.paymentStatus,
    });
    const { paymentStatus, paymentDue, paidAmount } = settled;

    const prevTotal = toNumber(existing.totalAmount);
    const prevDate = existing.expenseDate;

    const priorDebit = await this.tenantDb.db.accountTransaction.findFirst({
      where: {
        tenantId,
        expenseId: id,
        deletedAt: null,
        type: 'debit',
        subType: 'expense',
      },
      orderBy: { createdAt: 'desc' },
      select: { paymentMethod: true },
    });
    const nextPaymentMethod =
      dto.paymentMethod !== undefined
        ? dto.paymentMethod
        : (priorDebit?.paymentMethod ?? null);

    const row = await this.tenantDb.db.$transaction(async (tx) => {
      const updated = await tx.expense.update({
        where: { id },
        data: {
          ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
          ...(dto.refNo !== undefined ? { refNo: dto.refNo } : {}),
          ...(dto.subCategory !== undefined ? { subCategory: dto.subCategory } : {}),
          ...(dto.locationCode !== undefined ? { locationCode: dto.locationCode } : {}),
          ...(dto.expenseForCustomerId !== undefined
            ? { expenseForCustomerId: dto.expenseForCustomerId }
            : {}),
          ...(dto.contactCustomerId !== undefined
            ? { contactCustomerId: dto.contactCustomerId }
            : {}),
          ...(dto.expenseFor !== undefined ? { expenseFor: dto.expenseFor } : {}),
          ...(dto.contactName !== undefined ? { contactName: dto.contactName } : {}),
          ...(dto.totalAmount !== undefined ? { totalAmount: dto.totalAmount } : {}),
          ...(dto.taxAmount !== undefined ? { taxAmount: dto.taxAmount } : {}),
          paymentStatus,
          paymentDue,
          ...(dto.note !== undefined ? { note: dto.note } : {}),
          ...(dto.accountId !== undefined
            ? { accountId: dto.accountId || null }
            : {}),
          ...(dto.isRecurring !== undefined ? { isRecurring: dto.isRecurring } : {}),
          ...(dto.recurInterval !== undefined
            ? { recurInterval: dto.recurInterval }
            : {}),
          ...(dto.recurIntervalType !== undefined
            ? { recurIntervalType: dto.recurIntervalType }
            : {}),
          ...(dto.expenseDate !== undefined
            ? { expenseDate: new Date(dto.expenseDate) }
            : {}),
        },
        include: expenseInclude,
      });

      const shouldDebit = Boolean(accountId) && paidAmount > 0;
      await syncExpenseAccountDebit(tx, {
        tenantId,
        expenseId: updated.id,
        accountId: shouldDebit ? accountId : null,
        amount: paidAmount,
        operationDate: updated.expenseDate,
        refNo: updated.refNo,
        note:
          dto.paymentNote?.trim() ||
          updated.note ||
          `Expense — ${updated.refNo ?? updated.id}`,
        paymentMethod: nextPaymentMethod,
      });

      await upsertExpenseLedgerEntry(tx, {
        tenantId,
        expenseId: updated.id,
        amount: updatedTotal,
        category: updated.category?.name ?? updated.subCategory ?? 'Expense',
        description:
          updated.note?.trim() ||
          updated.refNo ||
          `Expense ${updated.id.slice(-8)}`,
        date: updated.expenseDate,
      });

      await this.invoiceHub.ensureExpenseInvoice(tx, updated);

      return updated;
    });

    let createdByName: string | null = null;
    if (row.createdById) {
      const user = await this.tenantDb.db.user.findFirst({
        where: { id: row.createdById },
        select: { name: true },
      });
      createdByName = user?.name ?? null;
    }
    const nextTotal = toNumber(row.totalAmount);
    const amountDelta = nextTotal - prevTotal;
    if (amountDelta !== 0) {
      void applyDailyFinanceDelta(
        this.tenantDb.db,
        tenantId,
        row.expenseDate,
        'expense',
        amountDelta,
      );
    } else if (row.expenseDate.getTime() !== prevDate.getTime()) {
      void applyDailyFinanceDelta(
        this.tenantDb.db,
        tenantId,
        prevDate,
        'expense',
        -prevTotal,
      );
      void applyDailyFinanceDelta(
        this.tenantDb.db,
        tenantId,
        row.expenseDate,
        'expense',
        nextTotal,
      );
    }
    this.invalidateCaches();
    void this.auditService.log({
      action: 'updated',
      entityType: 'expense',
      entityId: row.id,
      summary: `Updated expense ${row.refNo?.trim() || row.id.slice(-8)}`,
      metadata: {
        totalAmount: toNumber(row.totalAmount),
        paymentStatus: row.paymentStatus,
      },
    });
    return this.serializeExpense(row, createdByName, nextPaymentMethod);
  }

  /**
   * Apply an incremental payment toward remaining expense due — same UX as
   * sales/purchases Add Payment (does not reopen the expense create form).
   */
  async payExpense(
    id: string,
    dto: PayContactDueRequest,
  ): Promise<{
    expenseId: string;
    amountApplied: number;
    currency: string;
    remainingDue: number;
    paymentStatus: string;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Payment amount must be greater than zero');
    }
    const accountId = dto.accountId?.trim() || null;
    if (!accountId) {
      throw new BadRequestException(
        'Select a Payment Account so this expense payment posts to the account book',
      );
    }

    const existing = await this.tenantDb.db.expense.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: expenseInclude,
    });
    if (!existing) throw new NotFoundException('Expense not found');

    const total = toNumber(existing.totalAmount);
    const priorDue = Math.max(0, toNumber(existing.paymentDue));
    const priorPaid = Math.max(0, total - priorDue);
    if (priorDue <= 1e-6 || existing.paymentStatus === 'paid') {
      throw new BadRequestException('Expense is already paid');
    }

    const apply = Math.min(amount, priorDue);
    const nextPaid = priorPaid + apply;
    const paymentDue = Math.max(0, total - nextPaid);
    const paymentStatus = paymentStatusFromAmounts(
      total,
      nextPaid,
      existing.paymentStatus,
    );
    const method = dto.method?.trim() || 'cash';
    const paidOn = dto.paidOn ? new Date(dto.paidOn) : new Date();
    const note =
      dto.note?.trim() ||
      existing.note ||
      `Expense payment — ${existing.refNo ?? existing.id}`;

    await this.tenantDb.db.$transaction(async (tx) => {
      await tx.expense.update({
        where: { id },
        data: {
          paymentStatus,
          paymentDue,
          accountId,
        },
      });

      await syncExpenseAccountDebit(tx, {
        tenantId,
        expenseId: id,
        accountId,
        amount: nextPaid,
        operationDate: paidOn,
        refNo: existing.refNo,
        note,
        paymentMethod: method,
      });
    });

    this.invalidateCaches();
    void this.auditService.log({
      action: 'updated',
      entityType: 'expense',
      entityId: id,
      summary: `Paid ${apply.toFixed(2)} on expense ${existing.refNo?.trim() || id.slice(-8)}`,
      metadata: {
        amountApplied: apply,
        remainingDue: paymentDue,
        paymentStatus,
      },
    });

    return {
      expenseId: id,
      amountApplied: apply,
      currency: 'NGN',
      remainingDue: paymentDue,
      paymentStatus,
    };
  }

  async deleteExpense(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.expense.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Expense not found');
    const archivedRef = `${existing.refNo?.trim() || `EXP-${id.slice(-8)}`}__del_${id.slice(-8)}`;
    await this.tenantDb.db.$transaction(async (tx) => {
      await softDeleteExpenseAccountTxns(tx, { tenantId, expenseId: id });
      await tx.invoice.updateMany({
        where: { tenantId, expenseId: id, deletedAt: null },
        data: {
          deletedAt: new Date(),
          reference: archivedRef,
        },
      });
      await tx.ledgerEntry.updateMany({
        where: {
          tenantId,
          linkedRecordType: 'expense',
          linkedRecordId: id,
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });
      await tx.expense.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          // Free ref uniqueness for re-use after soft delete when invoices keyed on ref.
          refNo: existing.refNo
            ? `${existing.refNo}__del_${id.slice(-8)}`
            : existing.refNo,
        },
      });
    });
    void applyDailyFinanceDelta(
      this.tenantDb.db,
      tenantId,
      existing.expenseDate,
      'expense',
      -toNumber(existing.totalAmount),
    );
    this.invalidateCaches();
    void this.auditService.log({
      action: 'deleted',
      entityType: 'expense',
      entityId: id,
      summary: `Deleted expense ${existing.refNo?.trim() || id.slice(-8)}`,
    });
  }

  async listCategories(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
  } = {}): Promise<ExpenseCategory[]> {
    // Alphabetical — matches expense form / filter pickers (nameListCursor).
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'string',
    });
    const rows = await this.tenantDb.db.expenseCategory.findMany({
      where: {
        tenantId: this.tenantDb.requireTenantId(),
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      code: row.code,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  }

  async createCategory(
    dto: CreateExpenseCategoryRequest,
  ): Promise<ExpenseCategory> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.expenseCategory.create({
      data: {
        tenantId,
        name: dto.name,
        code: dto.code ?? null,
      },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      code: row.code,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async updateCategory(
    id: string,
    dto: { name?: string; code?: string },
  ): Promise<ExpenseCategory> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.expenseCategory.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Expense category not found');
    const row = await this.tenantDb.db.expenseCategory.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.code !== undefined ? { code: dto.code } : {}),
      },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      code: row.code,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async deleteCategory(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.expenseCategory.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Expense category not found');
    await this.tenantDb.db.expenseCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  private serializeExpense(
    row: ExpenseRow,
    createdByName: string | null = null,
    paymentMethod: string | null = null,
  ): Expense {
    return {
      id: row.id,
      tenantId: row.tenantId,
      refNo: row.refNo,
      categoryId: row.categoryId,
      categoryName: row.category?.name ?? null,
      subCategory: row.subCategory,
      locationCode: row.locationCode,
      expenseForCustomerId: row.expenseForCustomerId,
      expenseFor:
        row.expenseForCustomer?.name ?? row.expenseFor ?? null,
      contactCustomerId: row.contactCustomerId,
      contactName: row.contactCustomer?.name ?? row.contactName ?? null,
      totalAmount: toNumber(row.totalAmount),
      taxAmount: toNumber(row.taxAmount),
      paymentStatus: paymentStatusFromAmounts(
        toNumber(row.totalAmount),
        Math.max(0, toNumber(row.totalAmount) - toNumber(row.paymentDue)),
        row.paymentStatus,
      ),
      paymentDue: Math.max(0, toNumber(row.paymentDue)),
      note: row.note,
      accountId: row.accountId,
      accountName: row.account?.name ?? null,
      paymentMethod,
      isRecurring: row.isRecurring,
      recurInterval: row.recurInterval,
      recurIntervalType: row.recurIntervalType,
      expenseDate: toIso(row.expenseDate),
      createdById: row.createdById,
      createdByName: createdByName ?? row.createdByName ?? null,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }
}

/** Boot/cron: seed HQ6 default expense list pages (limit 25, all-time, rows+summary). */
export async function warmDefaultExpenseListPages(
  prisma: import('@prisma/client').PrismaClient,
  cache: CacheService,
  tenantId: string,
): Promise<void> {
  for (const limit of HQ6_LIST_WARM_LIMITS) {
    for (const includeSummary of [false, true] as const) {
      const filterKey = listPageFilterKey({
        search: undefined,
        from: undefined,
        to: undefined,
        locationCode: undefined,
        expenseForCustomerId: undefined,
        contactCustomerId: undefined,
        createdById: undefined,
        categoryId: undefined,
        paymentStatus: undefined,
        cursor: undefined,
        limit,
        sum: includeSummary ? 1 : 0,
      });
      await withListPageCache(
        cache,
        tenantId,
        'expenses',
        filterKey,
        async () => {
          const baseWhere = { tenantId, deletedAt: null as null };
          const rows = await prisma.expense.findMany({
            where: baseWhere,
            include: expenseInclude,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: limit,
          });
          const items = rows.map((row) => ({
            id: row.id,
            tenantId: row.tenantId,
            refNo: row.refNo,
            categoryId: row.categoryId,
            categoryName: row.category?.name ?? null,
            subCategory: row.subCategory,
            locationCode: row.locationCode,
            expenseForCustomerId: row.expenseForCustomerId,
            expenseFor: row.expenseForCustomer?.name ?? row.expenseFor ?? null,
            contactCustomerId: row.contactCustomerId,
            contactName: row.contactCustomer?.name ?? row.contactName ?? null,
            totalAmount: toNumber(row.totalAmount),
            taxAmount: toNumber(row.taxAmount),
            paymentStatus: paymentStatusFromAmounts(
              toNumber(row.totalAmount),
              Math.max(
                0,
                toNumber(row.totalAmount) - toNumber(row.paymentDue),
              ),
              row.paymentStatus,
            ),
            paymentDue: Math.max(0, toNumber(row.paymentDue)),
            note: row.note,
            accountId: row.accountId,
            accountName: row.account?.name ?? null,
            isRecurring: row.isRecurring,
            recurInterval: row.recurInterval,
            recurIntervalType: row.recurIntervalType,
            expenseDate: toIso(row.expenseDate),
            createdById: row.createdById,
            createdByName: row.createdByName ?? null,
            createdAt: toIso(row.createdAt),
            updatedAt: toIso(row.updatedAt),
          }));
          if (!includeSummary) {
            return { items };
          }
          const [totalCount, amountAgg, dueAgg] = await Promise.all([
            prisma.expense.count({ where: baseWhere }),
            prisma.expense.aggregate({
              where: baseWhere,
              _sum: { totalAmount: true },
            }),
            prisma.expense.aggregate({
              where: {
                ...baseWhere,
                paymentStatus: 'due',
                accountId: null,
              },
              _sum: { paymentDue: true },
            }),
          ]);
          return {
            items,
            totalCount,
            amountSummary: {
              totalAmount: toNumber(amountAgg._sum.totalAmount),
              totalDue: toNumber(dueAgg._sum.paymentDue),
              currency: 'NGN',
            },
          };
        },
        600,
      );
    }
  }
}
