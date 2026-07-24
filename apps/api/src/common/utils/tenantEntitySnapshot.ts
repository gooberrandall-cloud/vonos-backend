import type { GroupEntityStat } from '@vonos/types';
import { AUTOS_GROUP_CODES } from '@vonos/types';
import { Prisma, type PrismaClient } from '@prisma/client';
import { runPool } from './mapPool';
import { toNumber } from './serializers';

const NEON_QUERY_CONCURRENCY = 2;

export const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

export type GroupTenantRef = {
  id: string;
  code: string;
  archetype: string;
};

type EntityStatsBundle = {
  entityStats: GroupEntityStat[];
  lowByTenant: Map<string, number>;
  jobByTenant: Map<string, { active: number; pendingQc: number }>;
  retailLowStock: number;
  pendingInbound: number;
};

function compactNgn(amount: number): string {
  if (amount >= 1_000_000) return `₦ ${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `₦ ${Math.round(amount / 1_000)}K`;
  return `₦ ${Math.round(amount)}`;
}

function todayWindow(): { start: Date; end: Date } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

type LiveEntityMaps = {
  itemByTenant: Map<
    string,
    { sku: number; stockValue: number; lowStock: number }
  >;
  inboundByTenant: Map<string, number>;
  salesByTenant: Map<string, { revenue: number; returns: number }>;
  jobByTenant: Map<
    string,
    { active: number; pendingQc: number; revenue: number }
  >;
  apptByTenant: Map<string, { count: number; revenue: number }>;
  retailLowStock: number;
  pendingInbound: number;
};

async function fetchLiveEntityMaps(
  prisma: PrismaClient,
  groupTenants: GroupTenantRef[],
): Promise<LiveEntityMaps> {
  const { start: todayStart, end: todayEnd } = todayWindow();

  const stockIds = groupTenants
    .filter((t) => t.archetype === 'stock')
    .map((t) => t.id);
  const transactionIds = groupTenants
    .filter((t) => t.archetype === 'transaction')
    .map((t) => t.id);
  const jobIds = groupTenants
    .filter((t) => t.archetype === 'job')
    .map((t) => t.id);
  const appointmentIds = groupTenants
    .filter((t) => t.archetype === 'appointment')
    .map((t) => t.id);

  const itemTenantIds = [
    ...new Set([...stockIds, ...transactionIds, ...jobIds]),
  ];

  const vw = groupTenants.find((t) => t.code === 'VW');

  const [
    itemStats,
    inboundToday,
    salesToday,
    jobCounts,
    jobRevenue,
    appointmentStats,
    retailLowStock,
    pendingInbound,
  ] = await runPool(
    [
    () =>
    itemTenantIds.length > 0
      ? prisma.$queryRaw<
          Array<{
            tenantId: string;
            sku: bigint;
            stock_value: Prisma.Decimal | null;
            low_stock: bigint;
          }>
        >`
          SELECT
            "tenantId",
            COUNT(*)::bigint AS sku,
            COALESCE(SUM(quantity * "costPrice"), 0) AS stock_value,
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
    stockIds.length > 0
      ? prisma.$queryRaw<Array<{ tenantId: string; inbound: bigint }>>`
          SELECT "tenantId", COUNT(*)::bigint AS inbound
          FROM "StockMovement"
          WHERE "deletedAt" IS NULL
            AND type = 'inbound'
            AND date >= ${todayStart}
            AND "tenantId" IN (${Prisma.join(stockIds)})
          GROUP BY "tenantId"
        `
      : Promise.resolve([]),
    () =>
    transactionIds.length > 0
      ? prisma.$queryRaw<
          Array<{
            tenantId: string;
            revenue: Prisma.Decimal | null;
            returns: bigint;
          }>
        >`
          SELECT
            "tenantId",
            COALESCE(SUM(total), 0) AS revenue,
            COUNT(*) FILTER (
              WHERE status IN ('refunded', 'partially_refunded', 'written_off')
            )::bigint AS returns
          FROM "Sale"
          WHERE "deletedAt" IS NULL
            AND status::text <> 'draft'
            AND date >= ${todayStart}
            AND date <= ${todayEnd}
            AND "tenantId" IN (${Prisma.join(transactionIds)})
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
    jobIds.length > 0
      ? prisma.$queryRaw<
          Array<{ tenantId: string; revenue: Prisma.Decimal | null }>
        >`
          SELECT "tenantId", COALESCE(SUM(amount), 0) AS revenue
          FROM "LedgerEntry"
          WHERE "deletedAt" IS NULL
            AND type = 'revenue'
            AND date >= ${todayStart}
            AND date <= ${todayEnd}
            AND "tenantId" IN (${Prisma.join(jobIds)})
          GROUP BY "tenantId"
        `
      : Promise.resolve([]),
    () =>
    appointmentIds.length > 0
      ? prisma.$queryRaw<
          Array<{
            tenantId: string;
            count: bigint;
            revenue: Prisma.Decimal | null;
          }>
        >`
          SELECT
            "tenantId",
            COUNT(*)::bigint AS count,
            COALESCE(SUM("servicePrice"), 0) AS revenue
          FROM "Appointment"
          WHERE "deletedAt" IS NULL
            AND "startTime" >= ${todayStart}
            AND "startTime" <= ${todayEnd}
            AND "tenantId" IN (${Prisma.join(appointmentIds)})
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

  const itemByTenant = new Map(
    itemStats.map((row) => [
      row.tenantId,
      {
        sku: Number(row.sku),
        stockValue: toNumber(row.stock_value ?? 0),
        lowStock: Number(row.low_stock),
      },
    ]),
  );
  const revenueByJobTenant = new Map(
    jobRevenue.map((row) => [row.tenantId, toNumber(row.revenue ?? 0)]),
  );

  return {
    itemByTenant,
    inboundByTenant: new Map(
      inboundToday.map((row) => [row.tenantId, Number(row.inbound)]),
    ),
    salesByTenant: new Map(
      salesToday.map((row) => [
        row.tenantId,
        {
          revenue: toNumber(row.revenue ?? 0),
          returns: Number(row.returns),
        },
      ]),
    ),
    jobByTenant: new Map(
      jobCounts.map((row) => [
        row.tenantId,
        {
          active: Number(row.active),
          pendingQc: Number(row.pending_qc),
          revenue: revenueByJobTenant.get(row.tenantId) ?? 0,
        },
      ]),
    ),
    apptByTenant: new Map(
      appointmentStats.map((row) => [
        row.tenantId,
        {
          count: Number(row.count),
          revenue: toNumber(row.revenue ?? 0),
        },
      ]),
    ),
    retailLowStock,
    pendingInbound,
  };
}

function mapEntityStatsFromLive(
  groupTenants: GroupTenantRef[],
  maps: LiveEntityMaps,
): EntityStatsBundle {
  const lowByTenant = new Map(
    groupTenants.map((t) => [
      t.id,
      maps.itemByTenant.get(t.id)?.lowStock ?? 0,
    ]),
  );

  const entityStats: GroupEntityStat[] = groupTenants.map((tenant) => {
    switch (tenant.archetype) {
      case 'stock': {
        const items = maps.itemByTenant.get(tenant.id);
        return {
          code: tenant.code,
          stats: [
            `${(items?.sku ?? 0).toLocaleString()} SKU`,
            `${compactNgn(items?.stockValue ?? 0)} stock`,
            `${maps.inboundByTenant.get(tenant.id) ?? 0} inbound today`,
          ] as [string, string, string],
        };
      }
      case 'transaction': {
        const sales = maps.salesByTenant.get(tenant.id);
        const low = maps.itemByTenant.get(tenant.id)?.lowStock ?? 0;
        return {
          code: tenant.code,
          stats: [
            `${compactNgn(sales?.revenue ?? 0)} sales`,
            `${sales?.returns ?? 0} returns`,
            `${low} low stock`,
          ] as [string, string, string],
        };
      }
      case 'job': {
        const jobs = maps.jobByTenant.get(tenant.id);
        return {
          code: tenant.code,
          stats: [
            `${jobs?.active ?? 0} active jobs`,
            `${jobs?.pendingQc ?? 0} pending QC`,
            `${compactNgn(jobs?.revenue ?? 0)} revenue`,
          ] as [string, string, string],
        };
      }
      case 'appointment': {
        const appts = maps.apptByTenant.get(tenant.id);
        return {
          code: tenant.code,
          stats: [
            `${appts?.count ?? 0} appts today`,
            `${Math.max(0, 8 - (appts?.count ?? 0))} slots open`,
            `${compactNgn(appts?.revenue ?? 0)} revenue`,
          ] as [string, string, string],
        };
      }
      default:
        return {
          code: tenant.code,
          stats: ['—', '—', '—'] as [string, string, string],
        };
    }
  });

  return {
    entityStats,
    lowByTenant,
    jobByTenant: new Map(
      [...maps.jobByTenant.entries()].map(([id, row]) => [
        id,
        { active: row.active, pendingQc: row.pendingQc },
      ]),
    ),
    retailLowStock: maps.retailLowStock,
    pendingInbound: maps.pendingInbound,
  };
}

function mapEntityStatsFromSnapshots(
  groupTenants: GroupTenantRef[],
  rows: Array<{
    tenantId: string;
    archetype: string;
    sku: number;
    stockValue: Prisma.Decimal;
    lowStock: number;
    inboundToday: number;
    salesTodayRevenue: Prisma.Decimal;
    salesReturns: number;
    activeJobs: number;
    pendingQc: number;
    jobRevenueToday: Prisma.Decimal;
    apptsToday: number;
    apptRevenueToday: Prisma.Decimal;
    retailLowStock: number;
    pendingInbound: number;
    refreshedAt: Date;
  }>,
): EntityStatsBundle {
  const byTenant = new Map(rows.map((row) => [row.tenantId, row]));
  let retailLowStock = 0;
  let pendingInbound = 0;

  const entityStats: GroupEntityStat[] = groupTenants.map((tenant) => {
    const row = byTenant.get(tenant.id);
    if (!row) {
      return {
        code: tenant.code,
        stats: ['—', '—', '—'] as [string, string, string],
      };
    }

    if (tenant.code === 'VW') {
      retailLowStock = row.retailLowStock;
      pendingInbound = row.pendingInbound;
    }

    switch (tenant.archetype) {
      case 'stock':
        return {
          code: tenant.code,
          stats: [
            `${row.sku.toLocaleString()} SKU`,
            `${compactNgn(toNumber(row.stockValue))} stock`,
            `${row.inboundToday} inbound today`,
          ] as [string, string, string],
        };
      case 'transaction':
        return {
          code: tenant.code,
          stats: [
            `${compactNgn(toNumber(row.salesTodayRevenue))} sales`,
            `${row.salesReturns} returns`,
            `${row.lowStock} low stock`,
          ] as [string, string, string],
        };
      case 'job':
        return {
          code: tenant.code,
          stats: [
            `${row.activeJobs} active jobs`,
            `${row.pendingQc} pending QC`,
            `${compactNgn(toNumber(row.jobRevenueToday))} revenue`,
          ] as [string, string, string],
        };
      case 'appointment':
        return {
          code: tenant.code,
          stats: [
            `${row.apptsToday} appts today`,
            `${Math.max(0, 8 - row.apptsToday)} slots open`,
            `${compactNgn(toNumber(row.apptRevenueToday))} revenue`,
          ] as [string, string, string],
        };
      default:
        return {
          code: tenant.code,
          stats: ['—', '—', '—'] as [string, string, string],
        };
    }
  });

  const lowByTenant = new Map(
    groupTenants.map((t) => [t.id, byTenant.get(t.id)?.lowStock ?? 0]),
  );
  const jobByTenant = new Map(
    groupTenants
      .filter((t) => t.archetype === 'job')
      .map((t) => {
        const row = byTenant.get(t.id);
        return [
          t.id,
          {
            active: row?.activeJobs ?? 0,
            pendingQc: row?.pendingQc ?? 0,
          },
        ] as const;
      }),
  );

  return {
    entityStats,
    lowByTenant,
    jobByTenant,
    retailLowStock,
    pendingInbound,
  };
}

export async function tryLoadEntityStatsFromSnapshots(
  prisma: PrismaClient,
  groupTenants: GroupTenantRef[],
): Promise<EntityStatsBundle | null> {
  if (groupTenants.length === 0) return null;

  const tenantIds = groupTenants.map((t) => t.id);
  const rows = await prisma.tenantEntitySnapshot.findMany({
    where: { tenantId: { in: tenantIds } },
  });

  if (rows.length !== groupTenants.length) return null;

  const cutoff = Date.now() - SNAPSHOT_MAX_AGE_MS;
  if (rows.some((row) => row.refreshedAt.getTime() < cutoff)) {
    return null;
  }

  return mapEntityStatsFromSnapshots(groupTenants, rows);
}

export async function refreshTenantEntitySnapshots(
  prisma: PrismaClient,
  tenants?: GroupTenantRef[],
): Promise<number> {
  const groupTenants =
    tenants ??
    (await prisma.tenant.findMany({
      where: { code: { in: [...AUTOS_GROUP_CODES] }, deletedAt: null },
      select: { id: true, code: true, archetype: true },
      orderBy: { code: 'asc' },
    }));

  if (groupTenants.length === 0) return 0;

  const maps = await fetchLiveEntityMaps(prisma, groupTenants);
  await Promise.all(
    groupTenants.map((tenant) => {
      const items = maps.itemByTenant.get(tenant.id);
      const sales = maps.salesByTenant.get(tenant.id);
      const jobs = maps.jobByTenant.get(tenant.id);
      const appts = maps.apptByTenant.get(tenant.id);

      return prisma.tenantEntitySnapshot.upsert({
        where: { tenantId: tenant.id },
        create: {
          tenantId: tenant.id,
          archetype: tenant.archetype,
          sku: items?.sku ?? 0,
          stockValue: items?.stockValue ?? 0,
          lowStock: items?.lowStock ?? 0,
          inboundToday: maps.inboundByTenant.get(tenant.id) ?? 0,
          salesTodayRevenue: sales?.revenue ?? 0,
          salesReturns: sales?.returns ?? 0,
          activeJobs: jobs?.active ?? 0,
          pendingQc: jobs?.pendingQc ?? 0,
          jobRevenueToday: jobs?.revenue ?? 0,
          apptsToday: appts?.count ?? 0,
          apptRevenueToday: appts?.revenue ?? 0,
          retailLowStock:
            tenant.code === 'VW' ? maps.retailLowStock : 0,
          pendingInbound:
            tenant.code === 'VW' ? maps.pendingInbound : 0,
        },
        update: {
          archetype: tenant.archetype,
          sku: items?.sku ?? 0,
          stockValue: items?.stockValue ?? 0,
          lowStock: items?.lowStock ?? 0,
          inboundToday: maps.inboundByTenant.get(tenant.id) ?? 0,
          salesTodayRevenue: sales?.revenue ?? 0,
          salesReturns: sales?.returns ?? 0,
          activeJobs: jobs?.active ?? 0,
          pendingQc: jobs?.pendingQc ?? 0,
          jobRevenueToday: jobs?.revenue ?? 0,
          apptsToday: appts?.count ?? 0,
          apptRevenueToday: appts?.revenue ?? 0,
          retailLowStock:
            tenant.code === 'VW' ? maps.retailLowStock : 0,
          pendingInbound:
            tenant.code === 'VW' ? maps.pendingInbound : 0,
        },
      });
    }),
  );

  return groupTenants.length;
}

export async function buildGroupEntityStatsBundle(
  prisma: PrismaClient,
  tenants: GroupTenantRef[],
): Promise<EntityStatsBundle> {
  const fromSnapshot = await tryLoadEntityStatsFromSnapshots(prisma, tenants);
  if (fromSnapshot) return fromSnapshot;

  const maps = await fetchLiveEntityMaps(prisma, tenants);
  return mapEntityStatsFromLive(tenants, maps);
}

export type { EntityStatsBundle };
