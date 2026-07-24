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
import { resolveDateWindow } from '../reports/aggregators/date-utils';
import { sumDailyFinanceRollup, applyDailyFinanceDelta } from '../../common/utils/dailyFinanceRollup';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import {
  buildLedgerSummaryFromGroups,
  ledgerDateFilter,
} from '../../common/utils/ledgerAggregates';
import { computeOutstandingReceivables } from '../../common/utils/outstandingReceivables';
import { computeSalesRevenueTotal } from '../../common/utils/salesRevenue';
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

const LEDGER_CACHE_TTL_S = 900;

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cache: CacheService,
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
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.search
          ? {
              OR: [
                {
                  description: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
                {
                  category: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
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

    const window = resolveDateWindow(from, to);
    const dateFilter = ledgerDateFilter(from, to);

    // Rollup first (1 RTT). Skip live groupBy when rollup covers the window —
    // avoids a 4-way Promise.all stampede on Neon wake.
    const rollup = await sumDailyFinanceRollup(
      this.tenantDb.db,
      tenantId,
      window.from,
      window.to,
    );
    const useRollup =
      rollup.revenue > 0 || rollup.costs > 0 || rollup.expenses > 0;

    const [currencyRow, outstanding, groups] = await Promise.all([
      this.tenantDb.db.ledgerEntry.findFirst({
        where: { tenantId, deletedAt: null, ...dateFilter },
        select: { currency: true },
        orderBy: { date: 'desc' },
      }),
      computeOutstandingReceivables(this.tenantDb.db, from, to),
      useRollup
        ? Promise.resolve(null)
        : this.tenantDb.db.ledgerEntry.groupBy({
            by: ['type'],
            where: { tenantId, deletedAt: null, ...dateFilter },
            _sum: { amount: true },
          }),
    ]);

    const summary = useRollup
      ? {
          revenue: rollup.revenue,
          costs: rollup.costs + rollup.expenses,
          net: rollup.net,
          currency: currencyRow?.currency ?? 'NGN',
          outstanding: 0,
        }
      : buildLedgerSummaryFromGroups(
          (groups ?? []).map((group) => ({
            type: group.type,
            _sum: { amount: group._sum.amount },
          })),
          currencyRow?.currency ?? 'NGN',
        );

    summary.outstanding = outstanding;

    if (summary.revenue === 0) {
      const salesRevenue = await computeSalesRevenueTotal(
        this.tenantDb.db,
        from,
        to,
      );
      if (salesRevenue.revenue > 0) {
        summary.revenue = salesRevenue.revenue;
        summary.currency = salesRevenue.currency;
        summary.net = salesRevenue.revenue - summary.costs;
      }
    } else {
      summary.net = summary.revenue - summary.costs;
    }

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
      where: { tenantId, deletedAt: null, ...dateFilter },
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
    const row = await this.tenantDb.db.ledgerEntry.create({
      data: {
        tenantId,
        type: 'expense',
        amount: body.amount,
        currency: body.currency ?? 'NGN',
        category: body.category,
        description: body.description,
        date: body.date ? new Date(body.date) : new Date(),
      },
    });

    await applyDailyFinanceDelta(
      this.tenantDb.db,
      tenantId,
      row.date,
      'expense',
      toNumber(row.amount),
      row.currency,
    );

    await this.auditService.log({
      action: 'created',
      entityType: 'ledgerEntry',
      entityId: row.id,
      summary: `Manual expense: ${body.description}`,
      metadata: { category: body.category, amount: body.amount },
    });

    void invalidateTenantDashboardCache(this.cache, tenantId);

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
