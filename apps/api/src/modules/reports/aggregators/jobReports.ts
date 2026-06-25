import type { Decimal } from '@prisma/client/runtime/library';
import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';
import { computeDelta, priorWindow, resolveDateWindow } from './date-utils';

type JobTab = 'costing' | 'turnaround';

function jobCost(job: {
  materials: { totalCost: Decimal }[];
  labourEntries: { totalCost: Decimal }[];
}): number {
  const materials = job.materials.reduce(
    (sum, m) => sum + toNumber(m.totalCost),
    0,
  );
  const labour = job.labourEntries.reduce(
    (sum, l) => sum + toNumber(l.totalCost),
    0,
  );
  return materials + labour;
}

export async function buildJobReports(
  db: TenantScopedPrisma,
  tab: JobTab,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);

  const [jobs, activeJobs] = await Promise.all([
    db.job.findMany({
      where: {
        deletedAt: null,
        createdAt: { gte: prior.from, lte: window.to },
      },
      include: {
        materials: true,
        labourEntries: true,
      },
    }),
    db.job.count({
      where: {
        deletedAt: null,
        status: { notIn: ['Delivered', 'Cancelled'] },
      },
    }),
  ]);

  const periodJobs = jobs.filter(
    (j) => j.createdAt >= window.from && j.createdAt <= window.to,
  );
  const priorJobs = jobs.filter(
    (j) => j.createdAt >= prior.from && j.createdAt <= prior.to,
  );
  const completedJobs = periodJobs.filter(
    (j) => j.status === 'Delivered',
  ).length;
  const priorCompleted = priorJobs.filter(
    (j) => j.status === 'Delivered',
  ).length;

  const totalRevenue = periodJobs
    .filter((j) => j.status === 'Delivered' && j.quoteAmount != null)
    .reduce((sum, j) => sum + toNumber(j.quoteAmount), 0);
  const priorRevenue = priorJobs
    .filter((j) => j.status === 'Delivered' && j.quoteAmount != null)
    .reduce((sum, j) => sum + toNumber(j.quoteAmount), 0);

  const costs = periodJobs.map((j) => jobCost(j));
  const avgJobCost =
    costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
  const priorCosts = priorJobs.map((j) => jobCost(j));
  const priorAvgCost =
    priorCosts.length > 0
      ? priorCosts.reduce((a, b) => a + b, 0) / priorCosts.length
      : 0;

  if (tab === 'costing') {
    const monthBuckets = new Map<
      string,
      { label: string; materials: number; labour: number }
    >();
    for (const job of periodJobs) {
      const label = job.createdAt.toLocaleDateString('en-US', {
        month: 'short',
        year: '2-digit',
      });
      const key = `${job.createdAt.getFullYear()}-${job.createdAt.getMonth()}`;
      const materials = job.materials.reduce(
        (sum, m) => sum + toNumber(m.totalCost),
        0,
      );
      const labour = job.labourEntries.reduce(
        (sum, l) => sum + toNumber(l.totalCost),
        0,
      );
      const existing = monthBuckets.get(key);
      if (existing) {
        existing.materials += materials;
        existing.labour += labour;
      } else {
        monthBuckets.set(key, { label, materials, labour });
      }
    }
    const costChart = Array.from(monthBuckets.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );

    const statusCounts = new Map<string, number>();
    for (const job of jobs) {
      statusCounts.set(job.status, (statusCounts.get(job.status) ?? 0) + 1);
    }
    const pipelineData = Array.from(statusCounts.entries()).map(
      ([label, value]) => ({ label, value }),
    );

    return {
      kpis: [
        {
          label: 'Active Jobs',
          icon: 'wrench',
          metricKey: 'activeJobs',
          color: '#059669',
          value: activeJobs,
        },
        {
          label: 'Completed',
          icon: 'check-circle',
          metricKey: 'completedJobs',
          color: '#2563eb',
          value: completedJobs,
          ...computeDelta(completedJobs, priorCompleted),
        },
        {
          label: 'Revenue',
          icon: 'wallet',
          metricKey: 'totalRevenue',
          color: '#e11d48',
          value: totalRevenue,
          currency: 'NGN',
          ...computeDelta(totalRevenue, priorRevenue),
        },
        {
          label: 'Avg Job Cost',
          icon: 'calculator',
          metricKey: 'avgJobCost',
          color: '#9333ea',
          value: Math.round(avgJobCost),
          currency: 'NGN',
          ...computeDelta(avgJobCost, priorAvgCost),
        },
      ],
      charts: [
        {
          id: 'cost-stack',
          title: 'Materials vs Labour',
          subtitle: 'Cost breakdown by month',
          type: 'bar',
          series: [
            { name: 'Materials', dataKey: 'materials', color: '#3b82f6' },
            { name: 'Labour', dataKey: 'labour', color: '#93c5fd' },
          ],
          data:
            costChart.length > 0
              ? costChart.map((r) => ({
                  label: r.label,
                  materials: Math.round(r.materials),
                  labour: Math.round(r.labour),
                }))
              : [{ label: '—', materials: 0, labour: 0 }],
        },
        {
          id: 'status-pipeline',
          title: 'Status Pipeline',
          subtitle: 'All open and closed jobs',
          type: 'bar',
          horizontal: true,
          series: [{ name: 'Jobs', dataKey: 'value', color: '#10b981' }],
          data: pipelineData,
        },
      ],
      table:
        periodJobs.length > 0
          ? {
              columns: [
                { key: 'reference', header: 'Reference' },
                { key: 'customer', header: 'Customer' },
                { key: 'status', header: 'Status' },
                { key: 'revenue', header: 'Quote' },
                { key: 'cost', header: 'Cost' },
              ],
              rows: periodJobs.slice(0, 50).map((job) => ({
                id: job.id,
                recordType: 'job',
                reference: job.reference,
                customer: job.customerName ?? '—',
                status: job.status,
                revenue:
                  job.quoteAmount != null
                    ? Math.round(toNumber(job.quoteAmount))
                    : '—',
                cost: Math.round(jobCost(job)),
              })),
            }
          : null,
    };
  }
  const delivered = jobs.filter((j) => j.status === 'Delivered');
  const turnaroundDays = delivered.map((j) => {
    const days =
      (j.updatedAt.getTime() - j.createdAt.getTime()) / (24 * 60 * 60 * 1000);
    return Math.max(0, Math.round(days));
  });
  const avgTurnaround =
    turnaroundDays.length > 0
      ? turnaroundDays.reduce((a, b) => a + b, 0) / turnaroundDays.length
      : 0;

  const periodDelivered = periodJobs.filter((j) => j.status === 'Delivered');
  const priorDelivered = priorJobs.filter((j) => j.status === 'Delivered');
  const periodAvg =
    periodDelivered.length > 0
      ? periodDelivered.reduce((sum, j) => {
          const days =
            (j.updatedAt.getTime() - j.createdAt.getTime()) /
            (24 * 60 * 60 * 1000);
          return sum + Math.max(0, days);
        }, 0) / periodDelivered.length
      : 0;
  const priorAvg =
    priorDelivered.length > 0
      ? priorDelivered.reduce((sum, j) => {
          const days =
            (j.updatedAt.getTime() - j.createdAt.getTime()) /
            (24 * 60 * 60 * 1000);
          return sum + Math.max(0, days);
        }, 0) / priorDelivered.length
      : 0;

  const histogram = new Map<number, number>();
  for (const days of turnaroundDays) {
    const bucket = days <= 7 ? days : Math.min(30, Math.ceil(days / 7) * 7);
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
  }
  const histData = Array.from(histogram.entries())
    .sort(([a], [b]) => a - b)
    .map(([label, value]) => ({ label: `${label}d`, value }));

  return {
    kpis: [
      {
        label: 'Avg Turnaround',
        icon: 'clock',
        metricKey: 'avgTurnaroundDays',
        color: '#9333ea',
        value: Number(avgTurnaround.toFixed(1)),
        ...computeDelta(periodAvg, priorAvg),
      },
      {
        label: 'Jobs Delivered',
        icon: 'check-circle',
        metricKey: 'jobsDelivered',
        color: '#059669',
        value: periodDelivered.length,
        ...computeDelta(periodDelivered.length, priorDelivered.length),
      },
      {
        label: 'Active Jobs',
        icon: 'wrench',
        metricKey: 'activeJobs',
        color: '#2563eb',
        value: activeJobs,
      },
      {
        label: 'Revenue',
        icon: 'wallet',
        metricKey: 'totalRevenue',
        color: '#e11d48',
        value: totalRevenue,
        currency: 'NGN',
      },
    ],
    charts: [
      {
        id: 'turnaround-hist',
        title: 'Turnaround Distribution',
        subtitle: 'Days from received to delivered',
        type: 'bar',
        series: [{ name: 'Jobs', dataKey: 'value', color: '#3b82f6' }],
        data: histData.length > 0 ? histData : [{ label: '0d', value: 0 }],
      },
    ],
    table: null,
  };
}
