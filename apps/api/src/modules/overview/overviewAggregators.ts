import type { OverviewDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../common/prisma/prisma.service';
import { toMovementListRow } from '../stock-movements/stock-movements.mapper';
import { buildAppointmentReports } from '../reports/aggregators/appointmentReports';
import { buildJobReports } from '../reports/aggregators/jobReports';
import { buildStockReportsFromContext } from '../reports/aggregators/stockReports';
import { loadStockReportContext } from '../reports/aggregators/stockReportContext';
import { buildTransactionReports } from '../reports/aggregators/transactionReports';
import { loadSalesReportContext } from '../reports/aggregators/salesData';
import { aggregateTopProducts } from '../reports/aggregators/productSales';
import {
  computeDelta,
  buildTimeSeries,
} from '../reports/aggregators/date-utils';
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
  tenantCode: string,
  from?: string,
  to?: string,
): Promise<OverviewDashboard> {
  const stockCtx = await loadStockReportContext(db, from, to);
  const [movement, valuation, table, finance] = await Promise.all([
    Promise.resolve(buildStockReportsFromContext(stockCtx, 'movement')),
    Promise.resolve(buildStockReportsFromContext(stockCtx, 'valuation')),
    pendingMovementsTable(db),
    buildLedgerFinanceSlice(db, from, to),
  ]);

  const byKey = (key: string) =>
    [...valuation.kpis, ...movement.kpis].find((k) => k.metricKey === key);

  const totalSku = byKey('totalSku');
  const stockValue = byKey('stockValue');
  const todayInbound = byKey('todayInbound');
  const todayOutbound = byKey('todayOutbound');
  const movementCount = byKey('movementCount');

  const isKidsWear = tenantCode === 'VKW';
  let kpis = [totalSku, todayInbound, todayOutbound, stockValue].filter(
    (k): k is NonNullable<typeof k> => Boolean(k),
  );

  if (isKidsWear) {
    const sales = await buildTransactionReports(db, 'sales', from, to);
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
    financeCharts: finance.financeCharts,
    table: isKidsWear ? null : table,
    rankedList: null,
    jobStatusPie: null,
    tableStatus: null,
    timeline: null,
  };
}

export async function buildTransactionOverview(
  db: TenantScopedPrisma,
  tenantCode: string,
  from?: string,
  to?: string,
): Promise<OverviewDashboard> {
  const isCafe = tenantCode === 'VC';
  const isRetailCatalog = tenantCode === 'VISP' || tenantCode === 'VSP';

  const salesCtx = await loadSalesReportContext(db, from, to);
  const { window, periodSales } = salesCtx;

  const [sales, finance, lowStockItems] = await Promise.all([
    buildTransactionReports(db, 'sales', from, to, salesCtx),
    buildLedgerFinanceSlice(db, from, to),
    db.item.count({
      where: {
        deletedAt: null,
        status: { in: ['low_stock', 'out_of_stock'] },
      },
    }),
  ]);

  const { financeCharts, financeKpis } = finance;
  const [costsKpi, netKpi] = financeKpis;

  const topProducts = isRetailCatalog
    ? aggregateTopProducts(periodSales, 8)
    : [];
  const rankedList = topProducts.map((row) => ({
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
    data: buildTimeSeries(
      periodSales.map((sale) => ({ date: sale.date })),
      window,
      () => 1,
    ).map((row) => ({ label: row.label, orders: row.value })),
  };
  let hourlyChart = topChart;
  if (isCafe) {
    const buckets = new Map<number, number>();
    for (const sale of periodSales) {
      const hour = sale.date.getHours();
      buckets.set(hour, (buckets.get(hour) ?? 0) + 1);
    }
    hourlyChart = {
      id: 'hourly-orders',
      title: 'Orders Today',
      subtitle: 'Hourly order volume',
      type: 'bar',
      series: [{ name: 'Orders', dataKey: 'orders', color: '#f59e0b' }],
      data: Array.from(buckets.entries())
        .sort(([a], [b]) => a - b)
        .map(([hour, orders]) => ({
          label: `${hour}:00`,
          orders,
        })),
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
    financeCharts,
    table: null,
    rankedList: isRetailCatalog ? rankedList : null,
    jobStatusPie: null,
    tableStatus: isCafe ? { available: 0, occupied: 0, reserved: 0 } : null,
    timeline: null,
  };
}

export async function buildJobOverview(
  db: TenantScopedPrisma,
  tenantCode: string,
  from?: string,
  to?: string,
): Promise<OverviewDashboard> {
  const isMechanics = tenantCode === 'VM';
  const now = new Date();
  const soon = new Date(now);
  soon.setDate(soon.getDate() + 7);

  const [
    costing,
    finance,
    statusGroups,
    pendingQc,
    partsPending,
    dueSoon,
    inShop,
  ] = await Promise.all([
    buildJobReports(db, 'costing', from, to),
    buildLedgerFinanceSlice(db, from, to),
    db.job.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
    db.job.count({ where: { deletedAt: null, status: 'QC' } }),
    db.job.count({ where: { deletedAt: null, status: 'Approved' } }),
    isMechanics
      ? Promise.resolve([])
      : db.job.findMany({
          where: {
            deletedAt: null,
            status: { not: 'Delivered' },
            dueDate: { lte: soon },
          },
          orderBy: { dueDate: 'asc' },
          take: 8,
          select: {
            id: true,
            reference: true,
            status: true,
            customerName: true,
            dueDate: true,
          },
        }),
    isMechanics
      ? db.job.findMany({
          where: {
            deletedAt: null,
            status: 'In Progress',
            vehicleId: { not: null },
          },
          take: 8,
          select: {
            id: true,
            status: true,
            customerName: true,
            vehicleId: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const jobStatusPie = statusGroups.map((group) => ({
    label: group.status,
    value: group._count._all,
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
          reference: job.reference,
          customer: job.customerName ?? '—',
          dueDate: job.dueDate?.toISOString().slice(0, 10) ?? '—',
          status: job.status,
          overdue: job.dueDate && job.dueDate < now ? 'yes' : 'no',
        })),
      };

  const activeJobs = costing.kpis.find((k) => k.metricKey === 'activeJobs');
  const completed = costing.kpis.find((k) => k.metricKey === 'completedJobs');
  const revenue =
    finance.financeKpis.find((k) => k.metricKey === 'revenue') ??
    costing.kpis.find((k) => k.metricKey === 'totalRevenue');

  const kpis = isMechanics
    ? [
        {
          label: 'Open Jobs',
          icon: 'wrench',
          metricKey: 'openJobs',
          color: '#059669',
          value: activeJobs?.value ?? 0,
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
          currency: revenue?.currency ?? 'NGN',
        },
      ]
    : [
        {
          label: 'Active Jobs',
          icon: 'wrench',
          metricKey: 'activeJobs',
          color: '#059669',
          value: activeJobs?.value ?? 0,
        },
        {
          label: 'Completed',
          icon: 'check-circle',
          metricKey: 'completed',
          color: '#2563eb',
          value: completed?.value ?? 0,
          ...(completed?.delta !== undefined
            ? {
                delta: completed.delta,
                deltaLabel: completed.deltaLabel,
                deltaPercent: completed.deltaPercent,
              }
            : {}),
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
          currency: revenue?.currency ?? 'NGN',
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
    ],
    financeCharts: finance.financeCharts,
    table,
    rankedList: null,
    jobStatusPie,
    tableStatus: null,
    timeline: null,
  };
}

export async function buildAppointmentOverview(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<OverviewDashboard> {
  const stylist = await buildAppointmentReports(db, 'stylist', from, to);

  const appointments = await db.appointment.findMany({
    where: { deletedAt: null },
    include: { customer: { select: { name: true } } },
    orderBy: { startTime: 'asc' },
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const todayAppts = appointments.filter(
    (a) => a.startTime >= todayStart && a.startTime <= todayEnd,
  );

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
    client: a.customer?.name ?? 'Walk-in',
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
      client: a.customer?.name ?? 'Walk-in',
      service: a.serviceName,
      stylist: a.stylistName,
      status: a.status,
    })),
  };

  const revenue = stylist.kpis.find((k) => k.metricKey === 'revenue');
  const noShows = appointments.filter((a) => a.status === 'No-show').length;

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
