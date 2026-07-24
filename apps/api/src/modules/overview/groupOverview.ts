import type {
  GroupEntityStat,
  GroupOverviewAlert,
  GroupOverviewDashboard,
  GroupOverviewDetails,
  GroupOverviewSummary,
} from '@vonos/types';
import { AUTOS_GROUP_CODES } from '@vonos/types';
import { Prisma, type PrismaClient } from '@prisma/client';
import { resolveGroupFinanceSource } from '../../common/utils/dailyFinanceRollup';
import { runPool } from '../../common/utils/mapPool';
import {
  buildGroupEntityStatsBundle,
  type EntityStatsBundle,
} from '../../common/utils/tenantEntitySnapshot';
import {
  buildGroupCharts,
  buildGroupCoreKpis,
} from '../reports/aggregators/groupReports';
import { resolveDateWindow, defaultVagOverviewApiBounds } from '../reports/aggregators/date-utils';
import type { GroupFinanceQueryOptions } from '../reports/aggregators/groupReportQueries';

const NEON_QUERY_CONCURRENCY = 2;

type GroupTenant = {
  id: string;
  code: string;
  archetype: string;
};

const TENANT_LIST_TTL_MS = 5 * 60 * 1000;
let cachedAutosGroupTenants: {
  at: number;
  rows: GroupTenant[];
} | null = null;

/** Bucket cache keys so relative "now" ranges hit Redis within a few minutes. */
export function groupOverviewCacheWindowKey(
  from?: string,
  to?: string,
): string {
  const bucketMs = 5 * 60 * 1000;
  const floor = (iso: string | undefined, fallback: Date): string => {
    const d = iso ? new Date(iso) : fallback;
    if (Number.isNaN(d.getTime())) return '';
    return new Date(Math.floor(d.getTime() / bucketMs) * bucketMs).toISOString();
  };
  const now = new Date();
  return `${floor(from, now)}:${floor(to, now)}`;
}

async function loadAutosGroupTenants(
  prisma: PrismaClient,
): Promise<GroupTenant[]> {
  const now = Date.now();
  if (
    cachedAutosGroupTenants &&
    now - cachedAutosGroupTenants.at < TENANT_LIST_TTL_MS
  ) {
    return cachedAutosGroupTenants.rows;
  }
  const rows = await prisma.tenant.findMany({
    where: { code: { in: [...AUTOS_GROUP_CODES] }, deletedAt: null },
    select: { id: true, code: true, archetype: true },
    orderBy: { code: 'asc' },
  });
  cachedAutosGroupTenants = { at: now, rows };
  return rows;
}

function toTenantRows(tenants: GroupTenant[]) {
  return tenants.map((t) => ({
    id: t.id,
    code: t.code,
    name: t.code,
  }));
}

async function resolveGroupFinanceOptions(
  prisma: PrismaClient,
  tenantIds: string[],
  from?: string,
  to?: string,
): Promise<GroupFinanceQueryOptions> {
  const window = resolveDateWindow(from, to);
  const useRollup = await resolveGroupFinanceSource(
    prisma,
    tenantIds,
    window.from,
    window.to,
  );
  return { useRollup };
}

function buildGroupAlertsFromBundle(
  tenants: GroupTenant[],
  bundle: EntityStatsBundle,
): GroupOverviewAlert[] {
  const byCode = new Map(tenants.map((t) => [t.code, t]));
  const visp = byCode.get('VISP');
  const va = byCode.get('VA');
  const alerts: GroupOverviewAlert[] = [];

  if (bundle.retailLowStock > 0 && visp) {
    alerts.push({
      id: 'vw-low-retail-stock',
      severity: 'warning',
      title: 'Warehouse retail stock low',
      message: `${bundle.retailLowStock} SKU(s) available for retail catalog are low or out of stock.`,
      entityCode: 'VW',
      linkedRoute: '/VW/inventory',
    });
  }

  if (va) {
    const jobs = bundle.jobByTenant.get(va.id);
    const openJobs = jobs?.active ?? 0;
    const pendingQc = jobs?.pendingQc ?? 0;

    if (openJobs >= 3) {
      alerts.push({
        id: 'va-open-jobs',
        severity: 'info',
        title: 'Automotive workload',
        message: `${openJobs} open jobs — review parts requisitions against Warehouse stock.`,
        entityCode: 'VA',
        linkedRoute: '/VA/jobs',
      });
    }

    if (pendingQc > 0) {
      alerts.push({
        id: 'va-pending-qc',
        severity: 'info',
        title: 'Automotive QC queue',
        message: `${pendingQc} job(s) awaiting quality check.`,
        entityCode: 'VA',
        linkedRoute: '/VA/jobs',
      });
    }
  }

  if (bundle.pendingInbound > 0) {
    alerts.push({
      id: 'vw-pending-inbound',
      severity: 'warning',
      title: 'Pending warehouse purchases',
      message: `${bundle.pendingInbound} inbound movement(s) awaiting receipt at Warehouse.`,
      entityCode: 'VW',
      linkedRoute: '/VW/inbound',
    });
  }

  for (const tenant of tenants) {
    const lowStock = bundle.lowByTenant.get(tenant.id) ?? 0;
    if (lowStock > 0) {
      alerts.push({
        id: `low-stock-${tenant.code}`,
        severity: 'warning',
        title: `${tenant.code} low stock`,
        message: `${lowStock} SKU(s) at or below reorder point.`,
        entityCode: tenant.code,
        linkedRoute: `/${tenant.code}/inventory`,
      });
    }
  }

  return alerts;
}

/** Fallback when details path has no entity bundle — light job + low-stock probe. */
async function loadGroupAlertInputs(
  prisma: PrismaClient,
  tenants: GroupTenant[],
): Promise<EntityStatsBundle> {
  const itemTenantIds = tenants
    .filter(
      (t) =>
        t.archetype === 'stock' ||
        t.archetype === 'transaction' ||
        t.archetype === 'job',
    )
    .map((t) => t.id);
  const jobIds = tenants.filter((t) => t.archetype === 'job').map((t) => t.id);
  const vw = tenants.find((t) => t.code === 'VW');

  const [lowRows, jobCounts, retailLowStock, pendingInbound] =
    await runPool(
      [
        () =>
          itemTenantIds.length > 0
            ? prisma.$queryRaw<Array<{ tenantId: string; low_stock: bigint }>>`
                SELECT
                  "tenantId",
                  COUNT(*) FILTER (
                    WHERE status IN ('low_stock', 'out_of_stock')
                  )::bigint AS low_stock
                FROM "Item"
                WHERE "deletedAt" IS NULL
                  AND "tenantId" IN (${Prisma.join(itemTenantIds)})
                GROUP BY "tenantId"
              `
            : Promise.resolve([]),
        () =>
          jobIds.length > 0
            ? prisma.$queryRaw<
                Array<{ tenantId: string; active: bigint; pending_qc: bigint }>
              >`
                SELECT
                  "tenantId",
                  COUNT(*) FILTER (
                    WHERE status NOT IN ('Delivered', 'Cancelled')
                  )::bigint AS active,
                  COUNT(*) FILTER (WHERE status = 'QC')::bigint AS pending_qc
                FROM "Job"
                WHERE "deletedAt" IS NULL
                  AND "tenantId" IN (${Prisma.join(jobIds)})
                GROUP BY "tenantId"
              `
            : Promise.resolve([]),
        () =>
          vw
            ? prisma.item.count({
                where: {
                  tenantId: vw.id,
                  deletedAt: null,
                  availableForRetail: true,
                  status: { in: ['low_stock', 'out_of_stock'] },
                },
              })
            : Promise.resolve(0),
        () =>
          vw
            ? prisma.stockMovement.count({
                where: {
                  tenantId: vw.id,
                  deletedAt: null,
                  type: 'inbound',
                  status: 'Pending',
                },
              })
            : Promise.resolve(0),
      ],
      NEON_QUERY_CONCURRENCY,
    );

  const lowByTenant = new Map(
    lowRows.map((row) => [row.tenantId, Number(row.low_stock)]),
  );
  const jobByTenant = new Map(
    jobCounts.map((row) => [
      row.tenantId,
      {
        active: Number(row.active),
        pendingQc: Number(row.pending_qc),
      },
    ]),
  );

  return {
    entityStats: [] as GroupEntityStat[],
    lowByTenant,
    jobByTenant,
    retailLowStock,
    pendingInbound,
  };
}

const GROUP_CACHE_TTL_S = 900;

export async function buildGroupOverviewSummary(
  prisma: PrismaClient,
  from?: string,
  to?: string,
  cache?: import('../../common/cache/cache.service').CacheService,
): Promise<GroupOverviewSummary> {
  const cacheKey = `group-overview:summary:${groupOverviewCacheWindowKey(from, to)}`;

  if (cache) {
    const cached = await cache.get<GroupOverviewSummary>(cacheKey);
    if (cached) return cached;
  }

  const tenants = await loadAutosGroupTenants(prisma);
  const tenantRows = toTenantRows(tenants);
  const tenantIds = tenants.map((t) => t.id);
  const financeOptions = await resolveGroupFinanceOptions(
    prisma,
    tenantIds,
    from,
    to,
  );

  const [core, statsBundle] = await Promise.all([
    buildGroupCoreKpis(
      prisma,
      from,
      to,
      tenantRows,
      financeOptions,
    ),
    buildGroupEntityStatsBundle(prisma, tenants),
  ]);

  const result: GroupOverviewSummary = {
    kpis: core.kpis,
    entityStats: statsBundle.entityStats,
  };

  if (cache) {
    await cache.set(cacheKey, result, GROUP_CACHE_TTL_S);
  }

  return result;
}

export async function buildGroupOverviewDetails(
  prisma: PrismaClient,
  from?: string,
  to?: string,
  cache?: import('../../common/cache/cache.service').CacheService,
  revenueByTenant?: Map<string, number>,
  financeOptions?: GroupFinanceQueryOptions,
  alertBundle?: EntityStatsBundle,
): Promise<GroupOverviewDetails> {
  const cacheKey = `group-overview:details:${groupOverviewCacheWindowKey(from, to)}`;

  if (cache) {
    const cached = await cache.get<GroupOverviewDetails>(cacheKey);
    if (cached) return cached;
  }

  const tenants = await loadAutosGroupTenants(prisma);
  const tenantRows = toTenantRows(tenants);
  const tenantIds = tenants.map((t) => t.id);
  const financeOpts =
    financeOptions ??
    (await resolveGroupFinanceOptions(prisma, tenantIds, from, to));

  const chartsPromise = revenueByTenant
    ? buildGroupCharts(
        prisma,
        from,
        to,
        tenantRows,
        revenueByTenant,
        financeOpts,
      )
    : buildGroupCoreKpis(
        prisma,
        from,
        to,
        tenantRows,
        financeOpts,
      ).then((core) =>
        buildGroupCharts(
          prisma,
          from,
          to,
          tenantRows,
          core.revenueByTenant,
          financeOpts,
        ),
      );

  const [charts, bundle] = await Promise.all([
    chartsPromise,
    alertBundle
      ? Promise.resolve(alertBundle)
      : loadGroupAlertInputs(prisma, tenants),
  ]);

  const alerts = buildGroupAlertsFromBundle(tenants, bundle);

  const result: GroupOverviewDetails = { charts, alerts };

  if (cache) {
    await cache.set(cacheKey, result, GROUP_CACHE_TTL_S);
  }

  return result;
}

export async function buildGroupOverview(
  prisma: PrismaClient,
  from?: string,
  to?: string,
  cache?: import('../../common/cache/cache.service').CacheService,
): Promise<GroupOverviewDashboard> {
  const cacheKey = `group-overview:${groupOverviewCacheWindowKey(from, to)}`;

  if (cache) {
    const cached = await cache.get<GroupOverviewDashboard>(cacheKey);
    if (cached) return cached;
  }

  const tenants = await loadAutosGroupTenants(prisma);
  const tenantRows = toTenantRows(tenants);
  const tenantIds = tenants.map((t) => t.id);
  const financeOptions = await resolveGroupFinanceOptions(
    prisma,
    tenantIds,
    from,
    to,
  );

  const [core, statsBundle] = await Promise.all([
    buildGroupCoreKpis(
      prisma,
      from,
      to,
      tenantRows,
      financeOptions,
    ),
    buildGroupEntityStatsBundle(prisma, tenants),
  ]);

  const [charts, alerts] = await Promise.all([
    buildGroupCharts(
      prisma,
      from,
      to,
      tenantRows,
      core.revenueByTenant,
      financeOptions,
    ),
    Promise.resolve(buildGroupAlertsFromBundle(tenants, statsBundle)),
  ]);

  const result: GroupOverviewDashboard = {
    kpis: core.kpis,
    charts,
    entityStats: statsBundle.entityStats,
    alerts,
  };

  if (cache) {
    await cache.set(cacheKey, result, GROUP_CACHE_TTL_S);
  }

  return result;
}

/** Populate Redis + L1 for the default VAG home date range (last 7 days). */
export async function warmGroupOverviewCache(
  prisma: PrismaClient,
  cache: import('../../common/cache/cache.service').CacheService,
  from?: string,
  to?: string,
): Promise<void> {
  const defaults = defaultVagOverviewApiBounds();
  const warmFrom = from ?? defaults.from;
  const warmTo = to ?? defaults.to;

  await runPool(
    [
      () => buildGroupOverviewSummary(prisma, warmFrom, warmTo, cache),
      () => buildGroupOverviewDetails(prisma, warmFrom, warmTo, cache),
      () => buildGroupOverview(prisma, warmFrom, warmTo, cache),
    ],
    NEON_QUERY_CONCURRENCY,
  );
}
