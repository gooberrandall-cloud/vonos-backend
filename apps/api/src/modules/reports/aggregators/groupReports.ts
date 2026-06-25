import type { ReportsDashboard } from '@vonos/types';
import type { PrismaClient } from '@prisma/client';
import { toNumber } from '../../../common/utils/serializers';
import { resolveDateWindow } from './date-utils';

const ENTITY_COLORS: Record<string, string> = {
  VW: '#059669',
  VKW: '#ec4899',
  VISP: '#14b8a6',
  VSP: '#0d9488',
  VC: '#f59e0b',
  VM: '#D97706',
  VMS: '#B45309',
  VS: '#e11d48',
};

export async function buildGroupReports(
  prisma: PrismaClient,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);

  const tenants = await prisma.tenant.findMany({
    where: { code: { not: 'VAG' }, deletedAt: null },
    select: { id: true, code: true, name: true },
  });

  const tenantById = new Map(tenants.map((t) => [t.id, t]));

  const ledgerRows = await prisma.ledgerEntry.findMany({
    where: {
      deletedAt: null,
      type: 'revenue',
      date: { gte: window.from, lte: window.to },
      tenantId: { in: tenants.map((t) => t.id) },
    },
    select: { tenantId: true, amount: true, date: true },
  });

  const jobs = await prisma.job.findMany({
    where: {
      deletedAt: null,
      createdAt: { gte: window.from, lte: window.to },
      tenantId: { in: tenants.map((t) => t.id) },
    },
    select: { id: true, tenantId: true },
  });

  const jobsByTenant = new Map<string, number>();
  for (const job of jobs) {
    jobsByTenant.set(job.tenantId, (jobsByTenant.get(job.tenantId) ?? 0) + 1);
  }

  const groupRevenue = ledgerRows.reduce(
    (sum, row) => sum + toNumber(row.amount),
    0,
  );

  const revenueByTenant = new Map<string, number>();
  for (const row of ledgerRows) {
    revenueByTenant.set(
      row.tenantId,
      (revenueByTenant.get(row.tenantId) ?? 0) + toNumber(row.amount),
    );
  }

  const monthSeries = new Map<
    string,
    { label: string } & Record<string, number | string>
  >();
  for (const row of ledgerRows) {
    const tenant = tenantById.get(row.tenantId);
    if (!tenant) continue;
    const label = row.date.toLocaleDateString('en-US', {
      month: 'short',
      year: '2-digit',
    });
    const key = `${row.date.getFullYear()}-${row.date.getMonth()}`;
    const existing = monthSeries.get(key) ?? { label };
    existing[tenant.code] =
      Number(existing[tenant.code] ?? 0) + toNumber(row.amount);
    monthSeries.set(key, existing);
  }

  const trendData = Array.from(monthSeries.values()).sort((a, b) =>
    String(a.label).localeCompare(String(b.label)),
  );

  const entitySeries = tenants.map((t) => ({
    name: t.code,
    dataKey: t.code,
    color: ENTITY_COLORS[t.code] ?? '#64748b',
  }));

  const rankingData = tenants
    .map((t) => ({
      label: t.code,
      value: Math.round((revenueByTenant.get(t.id) ?? 0) / 1000),
      color: ENTITY_COLORS[t.code] ?? '#64748b',
    }))
    .sort((a, b) => b.value - a.value);

  const entityTableRows = tenants
    .map((t) => ({
      id: t.code,
      tenantCode: t.code,
      tenantName: t.name,
      revenue: Math.round(revenueByTenant.get(t.id) ?? 0),
      jobs: jobsByTenant.get(t.id) ?? 0,
      currency: 'NGN',
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    kpis: [
      {
        label: 'Group Revenue',
        icon: 'wallet',
        metricKey: 'revenue',
        color: '#059669',
        value: groupRevenue,
        currency: 'NGN',
      },
      {
        label: 'Total Jobs',
        icon: 'wrench',
        metricKey: 'jobs',
        color: '#2563eb',
        value: jobs.length,
      },
      {
        label: 'Active Entities',
        icon: 'package',
        metricKey: 'entities',
        color: '#9333ea',
        value: tenants.length,
      },
      {
        label: 'Outstanding',
        icon: 'clock',
        metricKey: 'outstanding',
        color: '#e11d48',
        value: 0,
      },
    ],
    charts: [
      {
        id: 'group-revenue-trend',
        title: 'Group Revenue Trend',
        subtitle:
          'One line per entity — transfer elimination between entities is deferred',
        type: 'line',
        series: entitySeries,
        data: trendData.length > 0 ? trendData : [{ label: '—', VW: 0 }],
      },
      {
        id: 'entity-comparison',
        title: 'Entity Comparison',
        subtitle: 'Revenue ranking for period (₦ thousands)',
        type: 'bar',
        horizontal: true,
        series: [{ name: 'Revenue', dataKey: 'value', color: '#059669' }],
        data: rankingData,
      },
    ],
    table: {
      columns: [
        { key: 'tenantCode', header: 'Entity' },
        { key: 'tenantName', header: 'Department' },
        { key: 'revenue', header: 'Revenue' },
        { key: 'jobs', header: 'Jobs' },
      ],
      rows: entityTableRows,
    },
  };
}
