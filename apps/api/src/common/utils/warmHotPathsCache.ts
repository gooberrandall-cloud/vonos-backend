import type { PrismaClient } from '@prisma/client';
import type { InvoiceSettings, OverviewDashboard, ReportsDashboard } from '@vonos/types';
import { AUTOS_GROUP_CODES } from '@vonos/types';
import type { CacheService } from '../cache/cache.service';
import { defaultVagOverviewApiBounds } from '../../modules/reports/aggregators/date-utils';
import {
  groupOverviewCacheWindowKey,
  warmGroupOverviewCache,
} from '../../modules/overview/groupOverview';
import {
  buildAppointmentOverview,
  buildJobOverview,
  buildStockOverview,
  buildTransactionOverview,
} from '../../modules/overview/overviewAggregators';
import { buildVaHq6HomeBundle } from '../../modules/overview/overviewFinance';
import {
  buildGroupLedgerByEntity,
  buildGroupLedgerSummary,
} from '../../modules/ledger/groupLedger';
import { buildGroupLedgerCharts } from '../../modules/ledger/ledgerCharts';
import { buildGroupReports } from '../../modules/reports/aggregators/groupReports';
import { buildJobReports } from '../../modules/reports/aggregators/jobReports';
import { buildStockReports } from '../../modules/reports/aggregators/stockReports';
import { buildTransactionReports } from '../../modules/reports/aggregators/transactionReports';
import { buildAppointmentReports } from '../../modules/reports/aggregators/appointmentReports';
import { runPool } from './mapPool';
import { toIso } from './serializers';
import type { TenantScopedPrisma } from '../prisma/prisma.service';
import { warmLegacyContactIdMap } from './legacyContactIdMap';
import { warmDefaultCustomerListPages } from '../../modules/customers/customers.service';
import { warmDefaultSupplierListPages } from '../../modules/suppliers/suppliers.service';
import { warmDefaultSalesListPages } from '../../modules/sales/sales.service';
import { warmDefaultStockMovementListPages } from '../../modules/stock-movements/stock-movements.service';

const WARM_CACHE_TTL_S = 900;
const INVOICE_SETTINGS_TTL_S = 600;
const REPORT_DASH_TTL_S = 900;
const VA_TENANT_ID = 'tenant_va_001';
const NEON_QUERY_CONCURRENCY = 2;

function warmBounds(from?: string, to?: string): { from: string; to: string } {
  const defaults = defaultVagOverviewApiBounds();
  return { from: from ?? defaults.from, to: to ?? defaults.to };
}

export async function warmGroupFinanceCache(
  prisma: PrismaClient,
  cache: CacheService,
  from?: string,
  to?: string,
): Promise<void> {
  const { from: warmFrom, to: warmTo } = warmBounds(from, to);
  const tenants = await prisma.tenant.findMany({
    where: { code: { in: [...AUTOS_GROUP_CODES] }, deletedAt: null },
    select: { id: true },
  });
  const tenantIds = tenants.map((t) => t.id);

  const summaryKey = `ledger-group-summary:${warmFrom}:${warmTo}`;
  const chartsKey = `ledger-group-charts:${warmFrom}:${warmTo}`;
  const byEntityKey = `ledger-group-by-entity:${warmFrom}:${warmTo}`;

  const [summary, charts, byEntity] = await runPool(
    [
      () => buildGroupLedgerSummary(prisma, warmFrom, warmTo),
      () => buildGroupLedgerCharts(prisma, tenantIds, warmFrom, warmTo),
      () => buildGroupLedgerByEntity(prisma, warmFrom, warmTo),
    ],
    NEON_QUERY_CONCURRENCY,
  );

  await Promise.all([
    cache.set(summaryKey, summary, WARM_CACHE_TTL_S),
    cache.set(chartsKey, charts, WARM_CACHE_TTL_S),
    cache.set(byEntityKey, byEntity, WARM_CACHE_TTL_S),
  ]);
}

export async function warmGroupReportsCache(
  prisma: PrismaClient,
  cache: CacheService,
  from?: string,
  to?: string,
): Promise<void> {
  const { from: warmFrom, to: warmTo } = warmBounds(from, to);
  const cacheKey = `report-group:${warmFrom}:${warmTo}`;
  const result = await buildGroupReports(prisma, warmFrom, warmTo);
  await cache.set(cacheKey, result, WARM_CACHE_TTL_S);
}

export async function warmEntityOverviewCache(
  prisma: PrismaClient,
  cache: CacheService,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<void> {
  const { from: warmFrom, to: warmTo } = warmBounds(from, to);
  const cacheKey = await cache.tenantScopedKey(
    tenantId,
    `entity-overview:${tenantId}:${groupOverviewCacheWindowKey(warmFrom, warmTo)}`,
  );
  const cached = await cache.get<OverviewDashboard>(cacheKey);
  if (cached) return;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { archetype: true, code: true },
  });
  if (!tenant) return;

  const db = prisma as unknown as TenantScopedPrisma;
  let result: OverviewDashboard;
  switch (tenant.archetype) {
    case 'stock':
      result = await buildStockOverview(
        db,
        tenantId,
        tenant.code,
        warmFrom,
        warmTo,
      );
      break;
    case 'transaction':
      result = await buildTransactionOverview(
        db,
        tenantId,
        tenant.code,
        warmFrom,
        warmTo,
      );
      break;
    case 'job':
      result = await buildJobOverview(
        db,
        tenantId,
        tenant.code,
        warmFrom,
        warmTo,
      );
      break;
    case 'appointment':
      result = await buildAppointmentOverview(db, tenantId, warmFrom, warmTo);
      break;
    default: {
      const _exhaustive: never = tenant.archetype as never;
      return _exhaustive;
    }
  }

  await cache.set(cacheKey, result, WARM_CACHE_TTL_S);
}

/** VA HQ6 home finance strip + charts. */
export async function warmVaHq6HomeCache(
  prisma: PrismaClient,
  cache: CacheService,
  tenantId = VA_TENANT_ID,
  from?: string,
  to?: string,
): Promise<void> {
  const { from: warmFrom, to: warmTo } = warmBounds(from, to);
  const cacheKey = await cache.tenantScopedKey(
    tenantId,
    `hq6-home:${tenantId}:${groupOverviewCacheWindowKey(warmFrom, warmTo)}`,
  );
  if (await cache.get(cacheKey)) return;

  const db = prisma as unknown as TenantScopedPrisma;
  const bundle = await buildVaHq6HomeBundle(db, tenantId, warmFrom, warmTo);
  await cache.set(
    cacheKey,
    {
      financeKpis: bundle.financeKpis,
      charts: bundle.charts,
      currency: bundle.currency,
      revenue: bundle.revenue,
    },
    WARM_CACHE_TTL_S,
  );
}

/** Reports dashboard miss path (VA = job archetype by default). */
export async function warmEntityReportDashboardCache(
  prisma: PrismaClient,
  cache: CacheService,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<void> {
  const { from: warmFrom, to: warmTo } = warmBounds(from, to);
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { archetype: true },
  });
  if (!tenant) return;

  const db = prisma as unknown as TenantScopedPrisma;
  const tabsByArchetype: Record<string, string[]> = {
    stock: ['valuation'],
    transaction: ['sales'],
    job: ['costing', 'turnaround'],
    appointment: ['stylist'],
  };
  const tabs = tabsByArchetype[tenant.archetype] ?? ['costing'];

  await runPool(
    tabs.map((tab) => async () => {
      const cacheKey = await cache.tenantScopedKey(
        tenantId,
        `report-dash:${tenantId}:${tab}:${warmFrom}:${warmTo}`,
      );
      if (await cache.get<ReportsDashboard>(cacheKey)) return;

      let result: ReportsDashboard;
      switch (tenant.archetype) {
        case 'stock':
          result = await buildStockReports(
            db,
            tenantId,
            (tab as 'valuation' | 'movement' | 'lowstock') || 'valuation',
            warmFrom,
            warmTo,
          );
          break;
        case 'transaction':
          result = await buildTransactionReports(
            db,
            tenantId,
            (tab as 'sales' | 'closeout') || 'sales',
            warmFrom,
            warmTo,
          );
          break;
        case 'job':
          result = await buildJobReports(
            db,
            tenantId,
            (tab as 'costing' | 'turnaround') || 'costing',
            warmFrom,
            warmTo,
          );
          break;
        case 'appointment':
          result = await buildAppointmentReports(
            db,
            tenantId,
            (tab as 'stylist' | 'noshow') || 'stylist',
            warmFrom,
            warmTo,
          );
          break;
        default:
          return;
      }
      await cache.set(cacheKey, result, REPORT_DASH_TTL_S);
    }),
    NEON_QUERY_CONCURRENCY,
  );
}

/** Invoice settings bag — avoids 25–30s cold seed/read on first open. */
export async function warmInvoiceSettingsCache(
  prisma: PrismaClient,
  cache: CacheService,
  tenantId: string,
): Promise<void> {
  const cacheKey = await cache.tenantScopedKey(
    tenantId,
    `invoice-settings:${tenantId}`,
  );
  if (await cache.get<InvoiceSettings>(cacheKey)) return;

  const where = { tenantId, deletedAt: null };
  const listOrder = [{ isDefault: 'desc' as const }, { name: 'asc' as const }];

  const layouts = await prisma.invoiceLayout.findMany({
    where,
    orderBy: listOrder,
  });
  const schemes = await prisma.invoiceScheme.findMany({
    where,
    orderBy: listOrder,
  });
  const printers = await prisma.receiptPrinter.findMany({
    where,
    orderBy: listOrder,
  });

  const defaultLayout = layouts.find((row) => row.isDefault) ?? layouts[0];
  const defaultScheme = schemes.find((row) => row.isDefault) ?? schemes[0];

  const result: InvoiceSettings = {
    layouts: layouts.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      design: row.design,
      headerText: row.headerText,
      footerText: row.footerText,
      termsText: row.termsText,
      isDefault: row.isDefault,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    })),
    schemes: schemes.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      prefix: row.prefix,
      startNumber: row.startNumber,
      invoiceCount: row.invoiceCount,
      totalDigits: row.totalDigits,
      isDefault: row.isDefault,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    })),
    printers: printers.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      printerType: row.printerType,
      connectionString: row.connectionString,
      isDefault: row.isDefault,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    })),
    defaultLayoutId: defaultLayout?.id ?? null,
    defaultSchemeId: defaultScheme?.id ?? null,
    termsText: defaultLayout?.termsText ?? null,
  };

  await cache.set(cacheKey, result, INVOICE_SETTINGS_TTL_S);
}

/**
 * Boot/cron warm for VAG admin + VA primary surfaces.
 * Runs sequentially across groups to stay within Neon pool limits.
 */
export async function warmHotPathsCache(
  prisma: PrismaClient,
  cache: CacheService,
  from?: string,
  to?: string,
): Promise<void> {
  await warmGroupOverviewCache(prisma, cache, from, to);
  await warmGroupFinanceCache(prisma, cache, from, to);
  await warmGroupReportsCache(prisma, cache, from, to);
  await warmEntityOverviewCache(prisma, cache, VA_TENANT_ID, from, to);
  await warmVaHq6HomeCache(prisma, cache, VA_TENANT_ID, from, to);
  await warmEntityReportDashboardCache(prisma, cache, VA_TENANT_ID, from, to);
  await warmInvoiceSettingsCache(prisma, cache, VA_TENANT_ID);
  // Legacy maps + default list pages — first user nav hits L1 instead of cold Neon.
  await warmLegacyContactIdMap(prisma, cache, VA_TENANT_ID, 'customer');
  await warmLegacyContactIdMap(prisma, cache, VA_TENANT_ID, 'supplier');
  await runPool(
    [
      () => warmDefaultCustomerListPages(prisma, cache, VA_TENANT_ID),
      () => warmDefaultSupplierListPages(prisma, cache, VA_TENANT_ID),
      () => warmDefaultSalesListPages(prisma, cache, VA_TENANT_ID),
      () => warmDefaultStockMovementListPages(prisma, cache, VA_TENANT_ID),
    ],
    2,
  );
}

export { warmGroupOverviewCache };
