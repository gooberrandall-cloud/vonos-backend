import type {
  GroupEntityStat,
  GroupOverviewAlert,
  GroupOverviewDashboard,
} from '@vonos/types';
import type { PrismaClient } from '@prisma/client';
import { toNumber } from '../../common/utils/serializers';
import { buildGroupReports } from '../reports/aggregators/groupReports';

function compactNgn(amount: number): string {
  if (amount >= 1_000_000) return `₦ ${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `₦ ${Math.round(amount / 1_000)}K`;
  return `₦ ${Math.round(amount)}`;
}

export async function buildGroupEntityStats(
  prisma: PrismaClient,
): Promise<GroupEntityStat[]> {
  const tenants = await prisma.tenant.findMany({
    where: { code: { not: 'VAG' }, deletedAt: null },
    select: { id: true, code: true, archetype: true },
    orderBy: { code: 'asc' },
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  return Promise.all(
    tenants.map(async (tenant): Promise<GroupEntityStat> => {
      switch (tenant.archetype) {
        case 'stock': {
          const [sku, inbound, items] = await Promise.all([
            prisma.item.count({
              where: { tenantId: tenant.id, deletedAt: null },
            }),
            prisma.stockMovement.count({
              where: {
                tenantId: tenant.id,
                deletedAt: null,
                type: 'inbound',
                date: { gte: todayStart },
              },
            }),
            prisma.item.findMany({
              where: { tenantId: tenant.id, deletedAt: null },
              select: { quantity: true, costPrice: true },
            }),
          ]);
          const stockValue = items.reduce(
            (sum, item) => sum + item.quantity * toNumber(item.costPrice),
            0,
          );
          return {
            code: tenant.code,
            stats: [
              `${sku.toLocaleString()} SKU`,
              `${compactNgn(stockValue)} stock`,
              `${inbound} inbound today`,
            ],
          };
        }
        case 'transaction': {
          const [sales, lowStock] = await Promise.all([
            prisma.sale.findMany({
              where: {
                tenantId: tenant.id,
                deletedAt: null,
                status: { not: 'draft' },
                date: { gte: todayStart },
              },
              select: { total: true, status: true },
            }),
            prisma.item.count({
              where: {
                tenantId: tenant.id,
                deletedAt: null,
                status: { in: ['low_stock', 'out_of_stock'] },
              },
            }),
          ]);
          const revenue = sales.reduce(
            (sum, sale) => sum + toNumber(sale.total),
            0,
          );
          const returns = sales.filter((s) => s.status === 'refunded').length;
          return {
            code: tenant.code,
            stats: [
              `${compactNgn(revenue)} sales`,
              `${returns} returns`,
              `${lowStock} low stock`,
            ],
          };
        }
        case 'job': {
          const [active, pendingQc, revenueAgg] = await Promise.all([
            prisma.job.count({
              where: {
                tenantId: tenant.id,
                deletedAt: null,
                status: { notIn: ['Delivered', 'Cancelled'] },
              },
            }),
            prisma.job.count({
              where: { tenantId: tenant.id, deletedAt: null, status: 'QC' },
            }),
            prisma.ledgerEntry.aggregate({
              where: {
                tenantId: tenant.id,
                deletedAt: null,
                type: 'revenue',
              },
              _sum: { amount: true },
            }),
          ]);
          return {
            code: tenant.code,
            stats: [
              `${active} active jobs`,
              `${pendingQc} pending QC`,
              `${compactNgn(toNumber(revenueAgg._sum.amount))} revenue`,
            ],
          };
        }
        case 'appointment': {
          const appts = await prisma.appointment.findMany({
            where: {
              tenantId: tenant.id,
              deletedAt: null,
              startTime: { gte: todayStart, lte: todayEnd },
            },
            select: { status: true, servicePrice: true },
          });
          const revenue = appts.reduce(
            (sum, a) => sum + toNumber(a.servicePrice),
            0,
          );
          return {
            code: tenant.code,
            stats: [
              `${appts.length} appts today`,
              `${Math.max(0, 8 - appts.length)} slots open`,
              `${compactNgn(revenue)} revenue`,
            ],
          };
        }
        default:
          return {
            code: tenant.code,
            stats: ['—', '—', '—'],
          };
      }
    }),
  );
}

export async function buildGroupAlerts(
  prisma: PrismaClient,
): Promise<GroupOverviewAlert[]> {
  const alerts: GroupOverviewAlert[] = [];

  const [vw, visp, vm, vms] = await Promise.all([
    prisma.tenant.findFirst({ where: { code: 'VW', deletedAt: null } }),
    prisma.tenant.findFirst({ where: { code: 'VISP', deletedAt: null } }),
    prisma.tenant.findFirst({ where: { code: 'VM', deletedAt: null } }),
    prisma.tenant.findFirst({ where: { code: 'VMS', deletedAt: null } }),
  ]);

  if (vw && visp) {
    const lowRetail = await prisma.item.count({
      where: {
        tenantId: vw.id,
        deletedAt: null,
        availableForRetail: true,
        status: { in: ['low_stock', 'out_of_stock'] },
      },
    });
    if (lowRetail > 0) {
      alerts.push({
        id: 'vw-low-retail-stock',
        severity: 'warning',
        title: 'Warehouse retail stock low',
        message: `${lowRetail} SKU(s) available for retail catalog are low or out of stock.`,
        entityCode: 'VW',
        linkedRoute: '/VW/inventory',
      });
    }
  }

  if (vm) {
    const [openJobs, pendingInbound] = await Promise.all([
      prisma.job.count({
        where: {
          tenantId: vm.id,
          deletedAt: null,
          status: { notIn: ['Delivered', 'Cancelled'] },
        },
      }),
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
    ]);

    if (openJobs >= 3) {
      alerts.push({
        id: 'vm-open-jobs',
        severity: 'info',
        title: 'Mechanics workload',
        message: `${openJobs} open jobs — review parts requisitions against Warehouse stock.`,
        entityCode: 'VM',
        linkedRoute: '/VM/jobs',
      });
    }

    if (pendingInbound > 0) {
      alerts.push({
        id: 'vw-pending-inbound',
        severity: 'warning',
        title: 'Pending warehouse purchases',
        message: `${pendingInbound} inbound movement(s) awaiting receipt at Warehouse.`,
        entityCode: 'VW',
        linkedRoute: '/VW/inbound',
      });
    }
  }

  if (vms) {
    const pendingQc = await prisma.job.count({
      where: { tenantId: vms.id, deletedAt: null, status: 'QC' },
    });
    if (pendingQc > 0) {
      alerts.push({
        id: 'vms-pending-qc',
        severity: 'info',
        title: 'Mech Shop QC queue',
        message: `${pendingQc} job(s) awaiting quality check.`,
        entityCode: 'VMS',
        linkedRoute: '/VMS/jobs',
      });
    }
  }

  return alerts;
}

export async function buildGroupOverview(
  prisma: PrismaClient,
  from?: string,
  to?: string,
): Promise<GroupOverviewDashboard> {
  const [dashboard, entityStats, alerts] = await Promise.all([
    buildGroupReports(prisma, from, to),
    buildGroupEntityStats(prisma),
    buildGroupAlerts(prisma),
  ]);
  return { ...dashboard, entityStats, alerts };
}
