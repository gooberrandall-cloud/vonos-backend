import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { runPool } from '../../../common/utils/mapPool';
import { computeDelta, priorWindow, resolveDateWindow } from './date-utils';
import {
  avgDeliveredTurnaroundDays,
  deliveredTurnaroundHistogram,
  jobCostByMonth,
  jobCostSummaryInWindow,
  jobTableRowsInWindow,
  sumDeliveredQuoteRevenue,
} from './jobReportQueries';

type JobTab = 'costing' | 'turnaround';

/** Neon pool-safe concurrency for report aggregations. */
const REPORT_QUERY_CONCURRENCY = 2;

function avgCost(summary: { jobCount: number; totalCost: number }): number {
  return summary.jobCount > 0 ? summary.totalCost / summary.jobCount : 0;
}

export async function buildJobReports(
  db: TenantScopedPrisma,
  tenantId: string,
  tab: JobTab,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);
  const pipelineFrom = prior.from;
  const pipelineTo = window.to;

  const jobCountWhere = (range: { from: Date; to: Date }, status?: string) => ({
    tenantId,
    deletedAt: null,
    createdAt: { gte: range.from, lte: range.to },
    ...(status ? { status } : {}),
  });

  if (tab === 'turnaround') {
    // Cap fan-out — unbounded Promise.all stampedes Neon and triggers P1001.
    const [
      activeJobs,
      totalRevenue,
      histogram,
      periodAvgTurnaround,
      priorAvgTurnaround,
      periodDelivered,
      priorDelivered,
    ] = await runPool(
      [
        () =>
          db.job.count({
            where: {
              tenantId,
              deletedAt: null,
              status: { notIn: ['Delivered', 'Cancelled'] },
            },
          }),
        () => sumDeliveredQuoteRevenue(db, tenantId, window.from, window.to),
        () =>
          deliveredTurnaroundHistogram(db, tenantId, window.from, window.to),
        () =>
          avgDeliveredTurnaroundDays(db, tenantId, window.from, window.to),
        () =>
          avgDeliveredTurnaroundDays(db, tenantId, prior.from, prior.to),
        () => db.job.count({ where: jobCountWhere(window, 'Delivered') }),
        () => db.job.count({ where: jobCountWhere(prior, 'Delivered') }),
      ],
      REPORT_QUERY_CONCURRENCY,
    );

    const histData = histogram.map((row) => ({
      label: `${row.bucket}d`,
      value: row.count,
    }));

    return {
      kpis: [
        {
          label: 'Avg Turnaround',
          icon: 'clock',
          metricKey: 'avgTurnaroundDays',
          color: '#9333ea',
          value: Number(periodAvgTurnaround.toFixed(1)),
          ...computeDelta(periodAvgTurnaround, priorAvgTurnaround),
        },
        {
          label: 'Jobs Delivered',
          icon: 'check-circle',
          metricKey: 'jobsDelivered',
          color: '#059669',
          value: periodDelivered,
          ...computeDelta(periodDelivered, priorDelivered),
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

  // Costing tab — two waves max concurrency 2 (KPIs then charts/table).
  const [
    activeJobs,
    completedJobs,
    priorCompleted,
    totalRevenue,
    priorRevenue,
    periodCostSummary,
    priorCostSummary,
  ] = await runPool(
    [
      () =>
        db.job.count({
          where: {
            tenantId,
            deletedAt: null,
            status: { notIn: ['Delivered', 'Cancelled'] },
          },
        }),
      () => db.job.count({ where: jobCountWhere(window, 'Delivered') }),
      () => db.job.count({ where: jobCountWhere(prior, 'Delivered') }),
      () => sumDeliveredQuoteRevenue(db, tenantId, window.from, window.to),
      () => sumDeliveredQuoteRevenue(db, tenantId, prior.from, prior.to),
      () => jobCostSummaryInWindow(db, tenantId, window.from, window.to),
      () => jobCostSummaryInWindow(db, tenantId, prior.from, prior.to),
    ],
    REPORT_QUERY_CONCURRENCY,
  );

  const [statusGroups, periodTableRows, costByMonth] = await runPool(
    [
      () =>
        db.job.groupBy({
          by: ['status'],
          where: {
            tenantId,
            deletedAt: null,
            createdAt: { gte: pipelineFrom, lte: pipelineTo },
          },
          _count: { _all: true },
        }),
      () => jobTableRowsInWindow(db, tenantId, window.from, window.to),
      () => jobCostByMonth(db, tenantId, window.from, window.to),
    ],
    REPORT_QUERY_CONCURRENCY,
  );

  const avgJobCost = avgCost(periodCostSummary);
  const priorAvgCost = avgCost(priorCostSummary);

  const pipelineData = statusGroups.map((group) => ({
    label: group.status,
    value: group._count._all,
  }));

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
          costByMonth.length > 0
            ? costByMonth.map((row) => ({
                label: row.label,
                materials: Math.round(row.materials),
                labour: Math.round(row.labour),
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
      periodTableRows.length > 0
        ? {
            columns: [
              { key: 'reference', header: 'Reference' },
              { key: 'customer', header: 'Customer' },
              { key: 'status', header: 'Status' },
              { key: 'revenue', header: 'Quote' },
              { key: 'cost', header: 'Cost' },
            ],
            rows: periodTableRows.map((job) => ({
              id: job.id,
              recordType: 'job',
              reference: job.reference,
              customer: job.customerName ?? '—',
              status: job.status,
              revenue:
                job.quoteAmount != null ? Math.round(job.quoteAmount) : '—',
              cost: Math.round(job.cost),
            })),
          }
        : null,
  };
}
