import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type {
  ProfitLossBreakdownTab,
  ReportRunOptions,
  ReportsDashboard,
} from '@vonos/types';
import { isPaginatedTableReport } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { ItemsService } from '../items/items.service';
import { buildAppointmentReports } from './aggregators/appointmentReports';
import { buildGroupReports } from './aggregators/groupReports';
import { buildJobReports } from './aggregators/jobReports';
import { buildStockReports } from './aggregators/stockReports';
import { buildTransactionReports } from './aggregators/transactionReports';
import { runGroupReport, runReportForTenant } from './reportRunner';
import {
  buildProfitLossBreakdownSection,
  buildProfitLossCore,
  buildProfitLossShell,
  buildProfitLossSummarySection,
} from './aggregators/financeReportHandlers';
import {
  deserializeProfitLossContext,
  ensureProfitLossBreakdownData,
  loadProfitLossContext,
  serializeProfitLossContext,
  type ProfitLossLoadContext,
  type ProfitLossLoadContextCached,
} from './aggregators/profitLossQueries';

export interface ReportsSummary {
  totalSku: number;
  todayInbound: number;
  todayOutbound: number;
  stockValue: number;
  currency: string;
  totalUnits: number;
  avgTurnover: number;
  stockValuesLabel: string;
}

const REPORT_CACHE_TTL_S = 900;
/** P&L context is expensive to rebuild — keep longer than generic reports. */
const PROFIT_LOSS_CACHE_TTL_S = 600;

const PROFIT_LOSS_BREAKDOWN_TABS = new Set<ProfitLossBreakdownTab>([
  'product',
  'category',
  'brand',
  'location',
  'invoice',
  'date',
  'customer',
  'day',
  'service-staff',
]);

export type ReportRunMode =
  | 'shell'
  | 'pl-core'
  | 'pl-summary'
  | 'pl-breakdown'
  | 'full';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly itemsService: ItemsService,
    private readonly cache: CacheService,
  ) {}

  private profitLossContextKey(
    tenantId: string,
    from?: string,
    to?: string,
  ): string {
    return `pl-ctx:${tenantId}:${from ?? ''}:${to ?? ''}`;
  }

  private logReportTiming(
    label: string,
    startedAt: number,
    meta: Record<string, string | undefined> & { cache: 'hit' | 'miss' | 'hit-upgrade' },
  ): void {
    const ms = Date.now() - startedAt;
    const parts = Object.entries(meta)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    this.logger.log(`${label} ${ms}ms ${parts}`);
  }

  private async getProfitLossContext(
    tenantId: string,
    from?: string,
    to?: string,
    includeBreakdown = false,
  ): Promise<ProfitLossLoadContext> {
    const startedAt = Date.now();
    // One shared key for core + breakdown so pl-core warms cache for tabs.
    const key = await this.cache.tenantScopedKey(
      tenantId,
      this.profitLossContextKey(tenantId, from, to),
    );
    const cached = await this.cache.get<ProfitLossLoadContextCached>(key);
    if (cached) {
      let loaded = deserializeProfitLossContext(cached);
      if (includeBreakdown && !loaded.hasBreakdownData) {
        loaded = await ensureProfitLossBreakdownData(
          this.tenantDb.db,
          loaded,
          from,
          to,
        );
        await this.cache.set(
          key,
          serializeProfitLossContext(loaded),
          PROFIT_LOSS_CACHE_TTL_S,
        );
        this.logReportTiming('pl-ctx', startedAt, {
          tenant: tenantId,
          from,
          to,
          cache: 'hit-upgrade',
        });
      } else {
        this.logReportTiming('pl-ctx', startedAt, {
          tenant: tenantId,
          from,
          to,
          cache: 'hit',
        });
      }
      return loaded;
    }

    const loaded = await loadProfitLossContext(
      this.tenantDb.db,
      tenantId,
      from,
      to,
      { includeBreakdown },
    );
    await this.cache.set(
      key,
      serializeProfitLossContext(loaded),
      PROFIT_LOSS_CACHE_TTL_S,
    );
    this.logReportTiming('pl-ctx', startedAt, {
      tenant: tenantId,
      from,
      to,
      cache: 'miss',
    });
    return loaded;
  }

  async summary(): Promise<ReportsSummary> {
    const kpi = await this.itemsService.kpiSummary();
    const totalUnitsResult = await this.tenantDb.db.item.aggregate({
      where: { deletedAt: null },
      _sum: { quantity: true },
    });
    const totalUnits = totalUnitsResult._sum.quantity ?? 0;
    const stockValueM = kpi.stockValue / 1_000_000;
    const stockValuesLabel = `₦ ${stockValueM.toFixed(1)}M`;

    return {
      ...kpi,
      totalUnits,
      avgTurnover:
        totalUnits > 0 ? Number((kpi.totalSku / totalUnits).toFixed(2)) : 0,
      stockValuesLabel,
    };
  }

  async dashboard(
    tab: string,
    from?: string,
    to?: string,
  ): Promise<ReportsDashboard> {
    const startedAt = Date.now();
    const tenantId = this.tenantDb.requireTenantId();
    const cacheKey = await this.cache.tenantScopedKey(
      tenantId,
      `report-dash:${tenantId}:${tab}:${from ?? ''}:${to ?? ''}`,
    );
    const cached = await this.cache.get<ReportsDashboard>(cacheKey);
    if (cached) {
      this.logReportTiming('dashboard', startedAt, {
        tenant: tenantId,
        tab,
        from,
        to,
        cache: 'hit',
      });
      return cached;
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { archetype: true },
    });
    if (!tenant) {
      throw new BadRequestException('Tenant not found');
    }

    const db = this.tenantDb.db;
    const archetype = tenant.archetype;

    let result: ReportsDashboard;
    switch (archetype) {
      case 'stock':
        result = await buildStockReports(
          db,
          tenantId,
          (tab as 'valuation' | 'movement' | 'lowstock') || 'valuation',
          from,
          to,
        );
        break;
      case 'transaction':
        result = await buildTransactionReports(
          db,
          tenantId,
          (tab as 'sales' | 'closeout') || 'sales',
          from,
          to,
        );
        break;
      case 'job':
        result = await buildJobReports(
          db,
          tenantId,
          (tab as 'costing' | 'turnaround') || 'costing',
          from,
          to,
        );
        break;
      case 'appointment':
        result = await buildAppointmentReports(
          db,
          tenantId,
          (tab as 'stylist' | 'noshow') || 'stylist',
          from,
          to,
        );
        break;
      default: {
        const _exhaustive: never = archetype;
        return _exhaustive;
      }
    }

    await this.cache.set(cacheKey, result, REPORT_CACHE_TTL_S);
    this.logReportTiming('dashboard', startedAt, {
      tenant: tenantId,
      tab,
      from,
      to,
      cache: 'miss',
    });
    return result;
  }

  async group(from?: string, to?: string): Promise<ReportsDashboard> {
    const startedAt = Date.now();
    const cacheKey = `report-group:${from ?? ''}:${to ?? ''}`;
    const cached = await this.cache.get<ReportsDashboard>(cacheKey);
    if (cached) {
      this.logReportTiming('group', startedAt, { from, to, cache: 'hit' });
      return cached;
    }

    const result = await buildGroupReports(this.prisma, from, to);
    await this.cache.set(cacheKey, result, REPORT_CACHE_TTL_S);
    this.logReportTiming('group', startedAt, { from, to, cache: 'miss' });
    return result;
  }

  async run(
    reportId: string,
    from?: string,
    to?: string,
    mode?: ReportRunMode,
    breakdownTab?: ProfitLossBreakdownTab,
    options?: ReportRunOptions,
  ): Promise<ReportsDashboard> {
    const startedAt = Date.now();
    const tenantId = this.tenantDb.requireTenantId();
    const resolvedMode =
      mode ?? (reportId === 'profit-loss' ? 'pl-core' : 'full');
    const filterKey = isPaginatedTableReport(reportId)
      ? JSON.stringify({
          cursor: options?.cursor ?? '',
          limit: options?.limit ?? '',
          search: options?.search ?? '',
          customerId: options?.customerId ?? '',
          customerGroupId: options?.customerGroupId ?? '',
          locationCode: options?.locationCode ?? '',
          accountId: options?.accountId ?? '',
          category: options?.category ?? '',
          brandId: options?.brandId ?? '',
          paymentMethod: options?.paymentMethod ?? '',
          supplierId: options?.supplierId ?? '',
          view: options?.view ?? '',
          taxTable: options?.taxTable ?? '',
        })
      : options?.accountId
        ? JSON.stringify({ accountId: options.accountId })
        : '';
    const hasReportFilters = Boolean(
      options?.search?.trim() ||
        options?.customerId ||
        options?.customerGroupId ||
        options?.locationCode ||
        options?.accountId ||
        options?.category ||
        options?.brandId ||
        options?.paymentMethod ||
        options?.supplierId ||
        options?.taxTable ||
        (options?.view && options.view !== 'detailed'),
    );
    const skipCache = Boolean(options?.cursor || hasReportFilters);
    const cacheKey = await this.cache.tenantScopedKey(
      tenantId,
      `report-run:${tenantId}:${reportId}:${resolvedMode}:${breakdownTab ?? ''}:${from ?? ''}:${to ?? ''}:${filterKey}`,
    );
    if (!skipCache) {
      const cached = await this.cache.get<ReportsDashboard>(cacheKey);
      if (cached) {
        this.logReportTiming('run', startedAt, {
          tenant: tenantId,
          report: reportId,
          mode: resolvedMode,
          from,
          to,
          cache: 'hit',
        });
        return cached;
      }
    }

    if (reportId === 'profit-loss' && resolvedMode !== 'full') {
      const db = this.tenantDb.db;
      let result: ReportsDashboard;
      switch (resolvedMode) {
        case 'shell':
          result = await buildProfitLossShell(db, tenantId, from, to);
          break;
        case 'pl-core': {
          const loaded = await this.getProfitLossContext(
            tenantId,
            from,
            to,
            false,
          );
          result = await buildProfitLossCore(db, tenantId, from, to, loaded);
          break;
        }
        case 'pl-summary': {
          const loaded = await this.getProfitLossContext(
            tenantId,
            from,
            to,
            false,
          );
          result = await buildProfitLossSummarySection(
            db,
            tenantId,
            from,
            to,
            loaded,
          );
          break;
        }
        case 'pl-breakdown': {
          if (!breakdownTab || !PROFIT_LOSS_BREAKDOWN_TABS.has(breakdownTab)) {
            throw new BadRequestException(
              'breakdownTab is required for pl-breakdown mode',
            );
          }
          const sectionStarted = Date.now();
          const section = await buildProfitLossBreakdownSection(
            this.tenantDb.db,
            tenantId,
            breakdownTab,
            from,
            to,
          );
          this.logReportTiming('pl-breakdown-sql', sectionStarted, {
            tenant: tenantId,
            tab: breakdownTab,
            from,
            to,
            cache: 'miss',
          });
          result = {
            kpis: [],
            charts: [],
            profitLoss: {
              summary: {
                currency: 'NGN',
                debits: [],
                credits: [],
                cogs: 0,
                grossProfit: 0,
                netProfit: 0,
              },
              breakdowns: { [section.tab]: section.breakdown },
            },
          };
          break;
        }
        default: {
          const _exhaustive: never = resolvedMode;
          throw new BadRequestException(`Unknown report mode: ${_exhaustive}`);
        }
      }
      if (!skipCache) {
        await this.cache.set(cacheKey, result, PROFIT_LOSS_CACHE_TTL_S);
      }
      this.logReportTiming('run', startedAt, {
        tenant: tenantId,
        report: reportId,
        mode: resolvedMode,
        from,
        to,
        cache: 'miss',
      });
      return result;
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { archetype: true },
    });
    if (!tenant) {
      throw new BadRequestException('Tenant not found');
    }
    const result = await runReportForTenant(
      reportId,
      {
        db: this.tenantDb.db,
        prisma: this.prisma,
        tenantId,
        archetype: tenant.archetype,
      },
      from,
      to,
      isPaginatedTableReport(reportId) ? options : undefined,
    );
    if (!skipCache) {
      await this.cache.set(cacheKey, result, REPORT_CACHE_TTL_S);
    }
    this.logReportTiming('run', startedAt, {
      tenant: tenantId,
      report: reportId,
      mode: resolvedMode,
      from,
      to,
      cache: 'miss',
    });
    return result;
  }

  async runGroup(reportId: string, from?: string, to?: string) {
    const startedAt = Date.now();
    const cacheKey = `report-group-run:${reportId}:${from ?? ''}:${to ?? ''}`;
    const cached = await this.cache.get<ReportsDashboard>(cacheKey);
    if (cached) {
      this.logReportTiming('group-run', startedAt, {
        report: reportId,
        from,
        to,
        cache: 'hit',
      });
      return cached;
    }

    const result = await runGroupReport(this.prisma, reportId, from, to);
    await this.cache.set(cacheKey, result, REPORT_CACHE_TTL_S);
    this.logReportTiming('group-run', startedAt, {
      report: reportId,
      from,
      to,
      cache: 'miss',
    });
    return result;
  }
}
