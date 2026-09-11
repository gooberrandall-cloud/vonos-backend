import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { runPool } from '../../../common/utils/mapPool';
import { computeDelta, priorWindow, resolveDateWindow } from './date-utils';
import {
  avgDeliveredTurnaroundPair,
  deliveredQuoteRevenuePair,
  deliveredTurnaroundHistogram,
  jobCostByMonth,
  jobCostSummaryPair,
  jobTableRowsInWindow,
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

  if (tab === 'turnaround') {
    const [activeJobs, revenuePair, histogram, turnaroundPair] = await runPool(
      [
        () =>
          db.job.count({
            where: {
              tenantId,
              deletedAt: null,
              status: { notIn: ['Delivered', 'Cancelled'] },
            },
          }),
        () =>
          deliveredQuoteRevenuePair(
            db,
            tenantId,
            window.from,
            window.to,
            prior.from,
            prior.to,
          ),
        () =>
          deliveredTurnaroundHistogram(db, tenantId, window.from, window.to),
        () =>
          avgDeliveredTurnaroundPair(
            db,
            tenantId,
            window.from,
            window.to,
            prior.from,
            prior.to,
          ),
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
          value: Number(turnaroundPair.current.toFixed(1)),
          ...computeDelta(turnaroundPair.current, turnaroundPair.prior),
        },
        {
          label: 'Jobs Delivered',
          icon: 'check-circle',
          metricKey: 'jobsDelivered',
          color: '#059669',
          value: revenuePair.currentDelivered,
          ...computeDelta(
            revenuePair.currentDelivered,
            revenuePair.priorDelivered,
          ),
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
          value: revenuePair.current,
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

  // Costing tab — paired current/prior queries cut Neon RTTs.
  const [activeJobs, revenuePair, costPair] = await runPool(
    [
      () =>
        db.job.count({
          where: {
            tenantId,
            deletedAt: null,
            status: { notIn: ['Delivered', 'Cancelled'] },
          },
        }),
      () =>
        deliveredQuoteRevenuePair(
          db,
          tenantId,
          window.from,
          window.to,
          prior.from,
          prior.to,
        ),
      () =>
        jobCostSummaryPair(
          db,
          tenantId,
          window.from,
          window.to,
          prior.from,
          prior.to,
        ),
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

  const avgJobCost = avgCost(costPair.current);
  const priorAvgCost = avgCost(costPair.prior);

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
        value: revenuePair.currentDelivered,
        ...computeDelta(
          revenuePair.currentDelivered,
          revenuePair.priorDelivered,
        ),
      },
      {
        label: 'Revenue',
        icon: 'wallet',
        metricKey: 'totalRevenue',
        color: '#e11d48',
        value: revenuePair.current,
        currency: 'NGN',
        ...computeDelta(revenuePair.current, revenuePair.prior),
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
