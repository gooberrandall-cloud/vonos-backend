import type { OverviewDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../common/prisma/prisma.service';
import { toMovementListRow } from '../stock-movements/stock-movements.mapper';
import { buildAppointmentReports } from '../reports/aggregators/appointmentReports';
import {
  appointmentKpiSnapshot,
  todayAppointmentSummary,
} from '../reports/aggregators/appointmentReportQueries';
import { buildStockReportsFromContext } from '../reports/aggregators/stockReports';
import { loadStockReportContext } from '../reports/aggregators/stockReportContext';
import { buildTransactionReports } from '../reports/aggregators/transactionReports';
import {
  hourlyOrderCounts,
  salesOrderTrend,
  topProductsInWindow,
} from '../reports/aggregators/salesReportQueries';
import { computeDelta, priorWindow, resolveDateWindow, asChartData } from '../reports/aggregators/date-utils';
import { buildLedgerFinanceSlice } from './overviewFinance';
const JOB_STATUS_COLORS: Record<string, string> = {
  Received: '#94a3b8',
  Quoted: '#64748b',
  Approved: '#3b82f6',
  'In Progress': '#475569',
  QC: '#f59e0b',
  Delivered: '#22c55e',
  Cancelled: '#ef4444',
};

type JobOverviewPhase1 = {
  activeJobs: number;
  pendingQc: number;
  completedJobs: number;
  priorCompleted: number;
  partsPending: number;
  statusGroups: Array<{ status: string; count: number }>;
  sampleJobs: Array<{
    id: string;
    reference: string | null;
    status: string;
    customerName: string | null;
    dueDate: Date | null;
    vehicleId: string | null;
  }>;
};

/** Single round-trip for VA/job overview phase-1 (counts + pie + sample rows). */
async function jobOverviewPhase1(
  db: TenantScopedPrisma,
  tenantId: string,
  window: { from: Date; to: Date },
  prior: { from: Date; to: Date },
  soon: Date,
  inShopSample: boolean,
): Promise<JobOverviewPhase1> {
  const rows = await db.$queryRaw<
    Array<{
      active_jobs: bigint;
      pending_qc: bigint;
      completed_jobs: bigint;
      prior_completed: bigint;
      parts_pending: bigint;
      status_groups: unknown;
      sample_jobs: unknown;
    }>
  >`
    WITH base AS (
      SELECT id, reference, status, "customerName", "dueDate", "vehicleId", "createdAt"
      FROM "Job"
      WHERE "tenantId" = ${tenantId}
        AND "deletedAt" IS NULL
    ),
    counts AS (
      SELECT
        COUNT(*) FILTER (
          WHERE status NOT IN ('Delivered', 'Cancelled')
        )::bigint AS active_jobs,
        COUNT(*) FILTER (WHERE status = 'QC')::bigint AS pending_qc,
        COUNT(*) FILTER (
          WHERE status = 'Delivered'
            AND "createdAt" >= ${window.from}
            AND "createdAt" <= ${window.to}
        )::bigint AS completed_jobs,
        COUNT(*) FILTER (
          WHERE status = 'Delivered'
            AND "createdAt" >= ${prior.from}
            AND "createdAt" <= ${prior.to}
        )::bigint AS prior_completed
      FROM base
    ),
    status_groups AS (
      SELECT COALESCE(
        json_agg(json_build_object('status', status, 'count', cnt) ORDER BY status),
        '[]'::json
      ) AS groups
      FROM (
        SELECT status, COUNT(*)::int AS cnt
        FROM base
        GROUP BY status
      ) s
    ),
    parts AS (
      SELECT COUNT(DISTINCT j.id)::bigint AS count
      FROM base j
      INNER JOIN "Requisition" r
        ON r."jobId" = j.id
       AND r."tenantId" = ${tenantId}
       AND r."deletedAt" IS NULL
       AND r.status IN ('Pending', 'Approved')
      WHERE j.status <> 'Delivered'
    ),
    sample AS (
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'id', id,
            'reference', reference,
            'status', status,
            'customerName', "customerName",
            'dueDate', "dueDate",
            'vehicleId', "vehicleId"
          )
        ),
        '[]'::json
      ) AS jobs
      FROM (
        SELECT id, reference, status, "customerName", "dueDate", "vehicleId"
        FROM base
        WHERE (
          ${inShopSample} = true
          AND status = 'In Progress'
          AND "vehicleId" IS NOT NULL
        ) OR (
          ${inShopSample} = false
          AND status <> 'Delivered'
          AND "dueDate" IS NOT NULL
          AND "dueDate" <= ${soon}
        )
        ORDER BY
          CASE WHEN ${inShopSample} = false THEN "dueDate" END ASC NULLS LAST,
          id ASC
        LIMIT 8
      ) x
    )
    SELECT
      c.active_jobs,
      c.pending_qc,
      c.completed_jobs,
      c.prior_completed,
      p.count AS parts_pending,
      sg.groups AS status_groups,
      s.jobs AS sample_jobs
    FROM counts c
    CROSS JOIN status_groups sg
    CROSS JOIN parts p
    CROSS JOIN sample s
  `;

  const row = rows[0];
  const statusGroupsRaw = Array.isArray(row?.status_groups)
    ? (row.status_groups as Array<{ status: string; count: number }>)
    : typeof row?.status_groups === 'string'
      ? (JSON.parse(row.status_groups) as Array<{ status: string; count: number }>)
      : [];
  const sampleRaw = Array.isArray(row?.sample_jobs)
    ? (row.sample_jobs as JobOverviewPhase1['sampleJobs'])
    : typeof row?.sample_jobs === 'string'
      ? (JSON.parse(row.sample_jobs) as JobOverviewPhase1['sampleJobs'])
      : [];

  return {
    activeJobs: Number(row?.active_jobs ?? 0),
    pendingQc: Number(row?.pending_qc ?? 0),
    completedJobs: Number(row?.completed_jobs ?? 0),
    priorCompleted: Number(row?.prior_completed ?? 0),
    partsPending: Number(row?.parts_pending ?? 0),
    statusGroups: statusGroupsRaw.map((g) => ({
      status: g.status,
      count: Number(g.count),
    })),
    sampleJobs: sampleRaw.map((job) => ({
      ...job,
      dueDate: job.dueDate ? new Date(job.dueDate) : null,
    })),
  };
}

async function pendingMovementsTable(
  db: TenantScopedPrisma,
): Promise<OverviewDashboard['table']> {
  const rows = await db.stockMovement.findMany({
    where: { deletedAt: null, status: { in: ['Pending', 'Approved'] } },
    orderBy: { date: 'asc' },
    take: 12,
  });

  if (rows.length === 0) return null;

  return {
    columns: [
      { key: 'ref', header: 'Reference' },
      { key: 'name', header: 'Destination' },
      { key: 'date', header: 'Date' },
      { key: 'carrier', header: 'Items' },
      { key: 'status', header: 'Status' },
    ],
    rows: rows.map((row) => {
      const list = toMovementListRow(row);
      return {
        id: list.id,
        ref: list.reference,
        name: list.supplierOrDest,
        date: list.date,
        carrier: String(list.itemCount),
        status: list.status,
      };
    }),
  };
}

export async function buildStockOverview(
  db: TenantScopedPrisma,
  tenantId: string,
  tenantCode: string,
  from?: string,
  to?: string,
): Promise<OverviewDashboard> {
  // Load stock context first, then parallelize independent slices.
  const stockCtx = await loadStockReportContext(db, tenantId, from, to);
  const [movement, valuation, table, finance, lowStockItems] = await Promise.all([
    buildStockReportsFromContext(stockCtx, db, 'movement'),
    buildStockReportsFromContext(stockCtx, db, 'valuation'),
    pendingMovementsTable(db),
    buildLedgerFinanceSlice(db, tenantId, from, to),
    db.item.count({
      where: {
        deletedAt: null,
        status: { in: ['low_stock', 'out_of_stock'] },
      },
    }),
  ]);

  const byKey = (key: string) =>
    [...valuation.kpis, ...movement.kpis].find((k) => k.metricKey === key);

  const totalSku = byKey('totalSku');
  const stockValue = byKey('stockValue');
  const todayInbound = byKey('todayInbound');
  const todayOutbound = byKey('todayOutbound');
  const movementCount = byKey('movementCount');

  const isKidsWear = tenantCode === 'VKW';
  const lowStockKpi = {
    label: 'Low Stock',
    icon: 'alert-triangle',
    metricKey: 'lowStock',
    color: '#f59e0b',
    value: lowStockItems,
  };
  let kpis = [
    totalSku,
    todayInbound,
    todayOutbound,
    stockValue,
    lowStockKpi,
  ].filter((k): k is NonNullable<typeof k> => Boolean(k));

  if (isKidsWear) {
    const sales = await buildTransactionReports(
      db,
      tenantId,
      'sales',
      from,
      to,
    );
    const revenue = sales.kpis.find((k) => k.metricKey === 'revenue');
    const refunded = sales.kpis.find((k) => k.metricKey === 'refundedCount');
    kpis = [
      totalSku!,
      {
        label: "Today's Sales",
        icon: 'shopping-bag',
        metricKey: 'todaySales',
        color: '#2563eb',
        value: revenue?.value ?? 0,
        currency: revenue?.currency ?? 'NGN',
        ...computeDelta(
          revenue?.value ?? 0,
          (revenue?.value ?? 0) - (revenue?.delta ?? 0),
        ),
      },
      {
        label: 'Returns',
        icon: 'rotate-ccw',
        metricKey: 'returns',
        color: '#9333ea',
        value: refunded?.value ?? 0,
      },
      stockValue!,
    ];
  }

  const charts = [
    movement.charts[0] ?? valuation.charts[0],
    valuation.charts[0] ?? movement.charts[0],
  ].filter(Boolean);

  if (movementCount && !isKidsWear) {
    const idx = kpis.findIndex((k) => k.metricKey === 'todayOutbound');
    if (idx >= 0 && movementCount.delta !== undefined) {
      kpis[idx] = {
        ...kpis[idx],
        ...computeDelta(
          movementCount.value,
          movementCount.value - (movementCount.delta ?? 0),
        ),
      };
    }
  }

  return {
    kpis,
    charts: charts.map((chart, index) => ({
      ...chart,
      id: chart.id ?? `stock-chart-${index}`,
      title:
        index === 0
          ? isKidsWear
            ? 'Inbound vs Outbound'
            : 'Inbound vs Outbound'
          : 'Inventory Value by Category',
    })),
    financeKpis: finance.financeKpis,
    financeCharts: finance.financeCharts,
    panels: [],
    table: isKidsWear ? null : table,
    rankedList: null,
    jobStatusPie: null,
    tableStatus: null,
    timeline: null,
  };
}

export async function buildTransactionOverview(
  db: TenantScopedPrisma,
  tenantId: string,
  tenantCode: string,
  from?: string,
  to?: string,
): Promise<OverviewDashboard> {
  const isCafe = tenantCode === 'VC';
  const isRetailCatalog = tenantCode === 'VISP' || tenantCode === 'VSP';
  const window = resolveDateWindow(from, to);

  const [sales, finance, lowStockItems, topProducts, orderTrend, hourlyOrders] =
    await Promise.all([
      buildTransactionReports(db, tenantId, 'sales', from, to),
      buildLedgerFinanceSlice(db, tenantId, from, to),
      db.item.count({
        where: {
          deletedAt: null,
          status: { in: ['low_stock', 'out_of_stock'] },
        },
      }),
      isRetailCatalog
        ? topProductsInWindow(db, tenantId, window.from, window.to, 8)
        : Promise.resolve([]),
      isRetailCatalog
        ? salesOrderTrend(db, tenantId, window)
        : Promise.resolve([]),
      isCafe
        ? hourlyOrderCounts(db, tenantId, window.from, window.to)
        : Promise.resolve([]),
    ]);

  const { financeCharts, financeKpis } = finance;
  const [costsKpi, netKpi] = financeKpis;

  const topProductsList = topProducts;
  const rankedList = topProductsList.map((row) => ({
    label: row.label,
    units: Math.round(row.units * 100) / 100,
    revenue: Math.round(row.revenue),
    currency:
      sales.kpis.find((k) => k.metricKey === 'revenue')?.currency ?? 'NGN',
    itemId: row.itemId,
  }));
  const revenue = sales.kpis.find((k) => k.metricKey === 'revenue');
  const transactionCount = sales.kpis.find(
    (k) => k.metricKey === 'transactionCount',
  );
  const refunded = sales.kpis.find((k) => k.metricKey === 'refundedCount');

  const kpis = isCafe
    ? [
        {
          label: "Today's Orders",
          icon: 'receipt',
          metricKey: 'todayOrders',
          color: '#059669',
          value: transactionCount?.value ?? 0,
          ...computeDelta(
            transactionCount?.value ?? 0,
            (transactionCount?.value ?? 0) - (transactionCount?.delta ?? 0),
          ),
        },
        {
          label: 'Active Tables',
          icon: 'grid-3x3',
          metricKey: 'activeTables',
          color: '#2563eb',
          value: 0,
        },
        {
          label: 'Low Stock',
          icon: 'alert-triangle',
          metricKey: 'lowStock',
          color: '#9333ea',
          value: lowStockItems,
        },
        {
          label: 'Revenue',
          icon: 'wallet',
          metricKey: 'revenue',
          color: '#e11d48',
          value: revenue?.value ?? 0,
          currency: revenue?.currency ?? 'NGN',
          ...(revenue?.delta !== undefined
            ? {
                delta: revenue.delta,
                deltaLabel: revenue.deltaLabel,
                deltaPercent: revenue.deltaPercent,
              }
            : {}),
        },
        costsKpi,
        netKpi,
      ]
    : [
        {
          label: 'Orders',
          icon: 'receipt',
          metricKey: 'transactionCount',
          color: '#2563eb',
          value: transactionCount?.value ?? 0,
          ...(transactionCount?.delta !== undefined
            ? {
                delta: transactionCount.delta,
                deltaLabel: transactionCount.deltaLabel,
                deltaPercent: transactionCount.deltaPercent,
              }
            : {}),
        },
        {
          label: 'Returns',
          icon: 'rotate-ccw',
          metricKey: 'returns',
          color: '#2563eb',
          value: refunded?.value ?? 0,
        },
        {
          label: 'Low Stock',
          icon: 'alert-triangle',
          metricKey: 'lowStock',
          color: '#9333ea',
          value: lowStockItems,
        },
        {
          label: 'Revenue',
          icon: 'wallet',
          metricKey: 'revenue',
          color: '#e11d48',
          value: revenue?.value ?? 0,
          currency: revenue?.currency ?? 'NGN',
        },
        costsKpi,
        netKpi,
      ];

  const topChart = sales.charts[0];
  const ordersTrendChart = {
    id: 'orders-trend',
    title: 'Orders Over Time',
    subtitle: 'Transaction count in selected period',
    type: 'bar' as const,
    series: [{ name: 'Orders', dataKey: 'orders', color: '#2563eb' }],
    data:
      orderTrend.length > 0 ? orderTrend : [{ label: '—', orders: 0 }],
  };
  let hourlyChart = topChart;
  if (isCafe) {
    hourlyChart = {
      id: 'hourly-orders',
      title: 'Orders Today',
      subtitle: 'Hourly order volume',
      type: 'bar',
      series: [{ name: 'Orders', dataKey: 'orders', color: '#f59e0b' }],
      data:
        hourlyOrders.length > 0
          ? asChartData(hourlyOrders)
          : asChartData([{ label: '—', orders: 0 }]),
    };
  }

  return {
    kpis,
    charts: isRetailCatalog
      ? [
          {
            ...topChart,
            id: 'revenue-today',
            title: 'Revenue Trend',
            subtitle: 'Sales over selected period',
          },
          ordersTrendChart,
        ]
      : isCafe
        ? [hourlyChart]
        : sales.charts,
    financeKpis,
    financeCharts,
    panels: [],
    table: null,
    rankedList: isRetailCatalog ? rankedList : null,
    jobStatusPie: null,
    tableStatus: isCafe ? { available: 0, occupied: 0, reserved: 0 } : null,
    timeline: null,
  };
}

export async function buildJobOverview(
  db: TenantScopedPrisma,
  tenantId: string,
  tenantCode: string,
  from?: string,
  to?: string,
): Promise<OverviewDashboard> {
  const isMechanics = tenantCode === 'VA';
  const now = new Date();
  const soon = new Date(now);
  soon.setDate(soon.getDate() + 7);
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);

  // Phase 1 — one SQL round trip (counts + status pie + sample rows + parts pending).
  const phase1 = await jobOverviewPhase1(
    db,
    tenantId,
    window,
    prior,
    soon,
    isMechanics,
  );

  const activeJobs = phase1.activeJobs;
  const pendingQc = phase1.pendingQc;
  const completedJobs = isMechanics ? 0 : phase1.completedJobs;
  const priorCompleted = isMechanics ? 0 : phase1.priorCompleted;
  const partsPending = phase1.partsPending;
  const inShop = isMechanics ? phase1.sampleJobs : [];
  const dueSoon = isMechanics ? [] : phase1.sampleJobs;

  // Phase 2 — non-VA job tenants need ledger finance. VA HQ6 home loads
  // finance via GET /overview/hq6-home (avoids stacking jsonb-heavy work here).
  const finance = isMechanics
    ? {
        currency: 'NGN',
        financeKpis: [],
        financeCharts: [],
      }
    : await buildLedgerFinanceSlice(db, tenantId, from, to);

  // Panels load via deferred frontend HTTP calls (avoids stacking 3 more queries here).
  const jobStatusPie = phase1.statusGroups.map((group) => ({
    label: group.status,
    value: group.count,
    color: JOB_STATUS_COLORS[group.status] ?? '#64748b',
  }));

  const table: OverviewDashboard['table'] = isMechanics
    ? {
        columns: [
          { key: 'plate', header: 'Plate' },
          { key: 'vehicle', header: 'Vehicle' },
          { key: 'status', header: 'Status' },
          { key: 'technician', header: 'Technician' },
        ],
        rows: inShop.map((job) => ({
          id: job.id,
          plate: job.vehicleId ?? '—',
          vehicle: job.customerName ?? 'Vehicle',
          status: job.status,
          technician: '—',
        })),
      }
    : {
        columns: [
          { key: 'reference', header: 'Reference' },
          { key: 'customer', header: 'Customer' },
          { key: 'dueDate', header: 'Due' },
          { key: 'status', header: 'Status' },
          { key: 'overdue', header: 'Overdue' },
        ],
        rows: dueSoon.map((job) => ({
          id: job.id,
          reference: job.reference ?? '—',
          customer: job.customerName ?? '—',
          dueDate: job.dueDate?.toISOString().slice(0, 10) ?? '—',
          status: job.status,
          overdue: job.dueDate && job.dueDate < now ? 'yes' : 'no',
        })),
      };

  const revenue = finance.financeKpis.find((k) => k.metricKey === 'revenue');
  const completedDelta = computeDelta(completedJobs, priorCompleted);

  const kpis = isMechanics
    ? [
        {
          label: 'Open Jobs',
          icon: 'wrench',
          metricKey: 'openJobs',
          color: '#059669',
          value: activeJobs,
        },
        {
          label: 'In Shop',
          icon: 'car',
          metricKey: 'inShop',
          color: '#2563eb',
          value: inShop.length,
        },
        {
          label: 'Pending QC',
          icon: 'shield-check',
          metricKey: 'pendingQc',
          color: '#9333ea',
          value: pendingQc,
        },
        {
          label: 'Parts Pending',
          icon: 'package',
          metricKey: 'partsPending',
          color: '#7c3aed',
          value: partsPending,
        },
        {
          label: 'Revenue',
          icon: 'wallet',
          metricKey: 'revenue',
          color: '#e11d48',
          value: revenue?.value ?? 0,
          currency: revenue?.currency ?? finance.currency,
        },
      ]
    : [
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
          metricKey: 'completed',
          color: '#2563eb',
          value: completedJobs,
          ...completedDelta,
        },
        {
          label: 'Pending QC',
          icon: 'shield-check',
          metricKey: 'pendingQc',
          color: '#9333ea',
          value: pendingQc,
        },
        {
          label: 'Revenue',
          icon: 'wallet',
          metricKey: 'revenue',
          color: '#e11d48',
          value: revenue?.value ?? 0,
          currency: revenue?.currency ?? finance.currency,
        },
      ];

  return {
    kpis,
    charts: [
      {
        id: 'job-status-pie',
        title: 'Job Status Distribution',
        subtitle: 'Current pipeline breakdown',
        type: 'pie',
        data: jobStatusPie.map((row) => ({
          label: row.label,
          value: row.value,
        })),
        series: jobStatusPie.map((row) => ({
          name: row.label,
          dataKey: 'value',
          color: row.color,
        })),
      },
    ] as OverviewDashboard['charts'],
    financeKpis: finance.financeKpis,
    financeCharts: finance.financeCharts,
    panels: [],
    table,
    rankedList: null,
    jobStatusPie,
    tableStatus: null,
    timeline: null,
  };
}

export async function buildAppointmentOverview(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<OverviewDashboard> {
  const window = resolveDateWindow(from, to);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const [stylist, todayRows, periodKpis, finance] = await Promise.all([
    buildAppointmentReports(db, tenantId, 'stylist', from, to),
    todayAppointmentSummary(db, tenantId, todayStart, todayEnd),
    appointmentKpiSnapshot(db, tenantId, window, todayStart, todayEnd),
    buildLedgerFinanceSlice(db, tenantId, from, to),
  ]);

  const todayAppts = todayRows;
  const stylists = [...new Set(todayAppts.map((a) => a.stylistName))];
  const hours = Array.from(
    new Set(
      todayAppts.map((a) =>
        a.startTime.toLocaleTimeString('en-US', {
          hour: 'numeric',
          hour12: true,
        }),
      ),
    ),
  ).sort();

  const blocks = todayAppts.map((a) => ({
    id: a.id,
    stylist: a.stylistName,
    hour: a.startTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      hour12: true,
    }),
    client: a.client ?? 'Walk-in',
    service: a.serviceName,
    status: a.status,
  }));

  const upcoming = todayAppts
    .filter((a) => a.startTime >= new Date() && a.status !== 'Completed')
    .slice(0, 10);

  const table: OverviewDashboard['table'] = {
    columns: [
      { key: 'time', header: 'Time' },
      { key: 'client', header: 'Client' },
      { key: 'service', header: 'Service' },
      { key: 'stylist', header: 'Stylist' },
      { key: 'status', header: 'Status' },
    ],
    rows: upcoming.map((a) => ({
      id: a.id,
      time: a.startTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }),
      client: a.client ?? 'Walk-in',
      service: a.serviceName,
      stylist: a.stylistName,
      status: a.status,
    })),
  };

  const revenue = stylist.kpis.find((k) => k.metricKey === 'revenue');
  const noShows = periodKpis.noShowCount;

  const kpis = [
    stylist.kpis.find((k) => k.metricKey === 'todayAppts')!,
    {
      label: 'Available Slots',
      icon: 'clock',
      metricKey: 'available',
      color: '#2563eb',
      value: Math.max(0, 8 - todayAppts.length),
    },
    {
      label: 'No-shows',
      icon: 'user-x',
      metricKey: 'noShows',
      color: '#9333ea',
      value: noShows,
    },
    {
      label: 'Revenue',
      icon: 'wallet',
      metricKey: 'revenue',
      color: '#e11d48',
      value: revenue?.value ?? 0,
      currency: revenue?.currency ?? 'NGN',
      ...(revenue?.delta !== undefined
        ? {
            delta: revenue.delta,
            deltaLabel: revenue.deltaLabel,
            deltaPercent: revenue.deltaPercent,
          }
        : {}),
    },
  ].filter(Boolean);

  return {
    kpis,
    charts: stylist.charts,
    financeKpis: finance.financeKpis,
    financeCharts: finance.financeCharts,
    panels: [],
    table,
    rankedList: null,
    jobStatusPie: null,
    tableStatus: null,
    timeline: {
      hours: hours.length > 0 ? hours : ['9 AM', '10 AM', '11 AM', '12 PM'],
      stylists: stylists.length > 0 ? stylists : ['Amara', 'Blessing'],
      blocks,
    },
  };
}
