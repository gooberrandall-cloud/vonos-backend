import { Injectable, Logger } from '@nestjs/common';
import type {
  LedgerEntry,
  LedgerEntryType,
  LedgerListRow,
  LedgerSummary,
} from '@vonos/types';
import { AUTOS_GROUP_CODES } from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { computeFinanceSummary } from '../../common/utils/financeSummary';
import { ledgerDateFilter } from '../../common/utils/ledgerAggregates';
import { toIso, toNumber } from '../../common/utils/serializers';
import {
  buildGroupLedgerByEntity,
  buildGroupLedgerCategories,
  buildGroupLedgerList,
  buildGroupLedgerSummary,
} from './groupLedger';
import {
  buildGroupLedgerCharts,
  buildTenantLedgerCharts,
} from './ledgerCharts';
import { CacheService } from '../../common/cache/cache.service';
import { ledgerTextSearchWhere } from '../../common/utils/listSearch';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import { excludeCashBookLedgerWhere } from '../../common/utils/ledgerCashBook';
import { ExpensesService } from '../expenses/expenses.service';

const LEDGER_CACHE_TTL_S = 900;

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cache: CacheService,
    private readonly expensesService: ExpensesService,
  ) {}

  private logLedgerTiming(
    label: string,
    startedAt: number,
    meta: Record<string, unknown>,
  ): void {
    const elapsedMs = Date.now() - startedAt;
    this.logger.log(`ledger:${label} ${elapsedMs}ms ${JSON.stringify(meta)}`);
  }

  async list(filters: {
    type?: LedgerEntryType;
    category?: string;
    from?: string;
    to?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  }): Promise<LedgerEntry[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      type: filters.type,
      category: filters.category,
      from: filters.from,
      to: filters.to,
      search: filters.search,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'ledger',
      filterKey,
      () => this.listUncached(filters, tenantId),
    );
  }

  private async listUncached(
    filters: {
      type?: LedgerEntryType;
      category?: string;
      from?: string;
      to?: string;
      search?: string;
      cursor?: string;
      limit?: number;
    },
    tenantId: string,
  ): Promise<LedgerEntry[]> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'date',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.tenantDb.db.ledgerEntry.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...excludeCashBookLedgerWhere(),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(ledgerTextSearchWhere(filters.search) ?? {}),
        ...ledgerDateFilter(filters.from, filters.to),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      type: row.type,
      amount: toNumber(row.amount),
      currency: row.currency,
      category: row.category,
      description: row.description,
      linkedRecordType: row.linkedRecordType,
      linkedRecordId: row.linkedRecordId,
      date: toIso(row.date),
      createdAt: toIso(row.createdAt),
    }));
  }

  async summary(from?: string, to?: string): Promise<LedgerSummary> {
    const startedAt = Date.now();
    const tenantId = this.tenantDb.requireTenantId();
    const cacheKey = await this.cache.tenantScopedKey(
      tenantId,
      `ledger-summary:${tenantId}:${from ?? ''}:${to ?? ''}`,
    );
    const cached = await this.cache.get<LedgerSummary>(cacheKey);
    if (cached) {
      this.logLedgerTiming('summary', startedAt, { from, to, cache: 'hit' });
      return cached;
    }

    const summary = await computeFinanceSummary(
      this.tenantDb.db,
      tenantId,
      from,
      to,
    );

    await this.cache.set(cacheKey, summary, LEDGER_CACHE_TTL_S);
    this.logLedgerTiming('summary', startedAt, { from, to, cache: 'miss' });
    return summary;
  }

  async charts(from?: string, to?: string) {
    const startedAt = Date.now();
    const tenantId = this.tenantDb.requireTenantId();
    const cacheKey = await this.cache.tenantScopedKey(
      tenantId,
      `ledger-charts:${tenantId}:${from ?? ''}:${to ?? ''}`,
    );
    const cached = await this.cache.get<Awaited<ReturnType<typeof buildTenantLedgerCharts>>>(cacheKey);
    if (cached) {
      this.logLedgerTiming('charts', startedAt, { from, to, cache: 'hit' });
      return cached;
    }

    const result = await buildTenantLedgerCharts(
      this.tenantDb.db,
      tenantId,
      from,
      to,
    );
    await this.cache.set(cacheKey, result, LEDGER_CACHE_TTL_S);
    this.logLedgerTiming('charts', startedAt, { from, to, cache: 'miss' });
    return result;
  }

  async categories(from?: string, to?: string): Promise<string[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const dateFilter = ledgerDateFilter(from, to);
    const rows = await this.tenantDb.db.ledgerEntry.groupBy({
      by: ['category'],
      where: {
        tenantId,
        deletedAt: null,
        ...excludeCashBookLedgerWhere(),
        ...dateFilter,
      },
      orderBy: { category: 'asc' },
    });
    return rows.map((row) => row.category);
  }

  async createManual(body: {
    type: 'expense';
    amount: number;
    category: string;
    description: string;
    date?: string;
    currency?: string;
  }): Promise<LedgerEntry> {
    const tenantId = this.tenantDb.requireTenantId();
    const categoryName = body.category.trim() || 'Expense';
    let categoryId: string | undefined;
    const existingCategory = await this.tenantDb.db.expenseCategory.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        name: { equals: categoryName, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (existingCategory) {
      categoryId = existingCategory.id;
    } else {
      const createdCategory = await this.tenantDb.db.expenseCategory.create({
        data: { tenantId, name: categoryName },
      });
      categoryId = createdCategory.id;
    }

    const expense = await this.expensesService.createExpense({
      categoryId,
      totalAmount: body.amount,
      note: body.description.trim(),
      expenseDate: body.date,
      paymentStatus: 'due',
    });

    const row = await this.tenantDb.db.ledgerEntry.findFirst({
      where: {
        tenantId,
        linkedRecordType: 'expense',
        linkedRecordId: expense.id,
        deletedAt: null,
      },
    });
    if (!row) {
      throw new Error('Expense ledger row missing after create');
    }

    await this.auditService.log({
      action: 'created',
      entityType: 'ledgerEntry',
      entityId: row.id,
      summary: `Manual expense: ${body.description}`,
      metadata: { category: body.category, amount: body.amount, expenseId: expense.id },
    });

    return {
      id: row.id,
      tenantId: row.tenantId,
      type: row.type,
      amount: toNumber(row.amount),
      currency: row.currency,
      category: row.category,
      description: row.description,
      linkedRecordType: row.linkedRecordType,
      linkedRecordId: row.linkedRecordId,
      date: toIso(row.date),
      createdAt: toIso(row.createdAt),
    };
  }

  groupList(filters: {
    type?: LedgerEntryType;
    category?: string;
    from?: string;
    to?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  }): Promise<LedgerListRow[]> {
    return buildGroupLedgerList(this.prisma, filters);
  }

  groupCategories(from?: string, to?: string): Promise<string[]> {
    return buildGroupLedgerCategories(this.prisma, from, to);
  }

  groupSummary(from?: string, to?: string): Promise<LedgerSummary> {
    return this.cachedGroupSummary(from, to);
  }

  groupByEntity(from?: string, to?: string) {
    return this.cachedGroupByEntity(from, to);
  }

  async groupCharts(from?: string, to?: string) {
    const cacheKey = `ledger-group-charts:${from ?? ''}:${to ?? ''}`;
    const cached = await this.cache.get<Awaited<ReturnType<typeof buildGroupLedgerCharts>>>(cacheKey);
    if (cached) return cached;

    const tenants = await this.prisma.tenant.findMany({
      where: {
        code: { in: [...AUTOS_GROUP_CODES] },
        deletedAt: null,
      },
      select: { id: true },
    });
    const result = await buildGroupLedgerCharts(
      this.prisma,
      tenants.map((t) => t.id),
      from,
      to,
    );
    await this.cache.set(cacheKey, result, LEDGER_CACHE_TTL_S);
    return result;
  }

  private async cachedGroupSummary(
    from?: string,
    to?: string,
  ): Promise<LedgerSummary> {
    const cacheKey = `ledger-group-summary:${from ?? ''}:${to ?? ''}`;
    const cached = await this.cache.get<LedgerSummary>(cacheKey);
    if (cached) return cached;
    const result = await buildGroupLedgerSummary(this.prisma, from, to);
    await this.cache.set(cacheKey, result, LEDGER_CACHE_TTL_S);
    return result;
  }

  private async cachedGroupByEntity(from?: string, to?: string) {
    const cacheKey = `ledger-group-by-entity:${from ?? ''}:${to ?? ''}`;
    const cached = await this.cache.get<Awaited<ReturnType<typeof buildGroupLedgerByEntity>>>(cacheKey);
    if (cached) return cached;
    const result = await buildGroupLedgerByEntity(this.prisma, from, to);
    await this.cache.set(cacheKey, result, LEDGER_CACHE_TTL_S);
    return result;
  }
}
