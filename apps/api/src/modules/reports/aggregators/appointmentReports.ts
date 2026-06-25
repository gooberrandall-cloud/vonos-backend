import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';
import {
  buildTimeSeries,
  computeDelta,
  countInWindow,
  priorWindow,
  resolveDateWindow,
} from './date-utils';

type AppointmentTab = 'stylist' | 'noshow';

export async function buildAppointmentReports(
  db: TenantScopedPrisma,
  tab: AppointmentTab,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);

  const appointments = await db.appointment.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      stylistName: true,
      serviceName: true,
      servicePrice: true,
      status: true,
      startTime: true,
      currency: true,
    },
  });

  const rows = appointments.map((a) => ({
    date: a.startTime,
    stylistName: a.stylistName,
    status: a.status,
    revenue: toNumber(a.servicePrice),
    currency: a.currency,
  }));

  const periodRows = rows.filter(
    (r) => r.date >= window.from && r.date <= window.to,
  );
  const priorRows = rows.filter(
    (r) => r.date >= prior.from && r.date <= prior.to,
  );

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const todayAppts = countInWindow(rows, { from: todayStart, to: todayEnd });

  const completedCount = periodRows.filter(
    (r) => r.status === 'Completed',
  ).length;
  const revenue = periodRows
    .filter((r) => r.status === 'Completed')
    .reduce((sum, r) => sum + r.revenue, 0);
  const priorRevenue = priorRows
    .filter((r) => r.status === 'Completed')
    .reduce((sum, r) => sum + r.revenue, 0);
  const currency = rows[0]?.currency ?? 'NGN';

  if (tab === 'stylist') {
    const byStylist = new Map<string, number>();
    for (const row of periodRows.filter((r) => r.status === 'Completed')) {
      byStylist.set(
        row.stylistName,
        (byStylist.get(row.stylistName) ?? 0) + row.revenue,
      );
    }
    const stylistChart = Array.from(byStylist.entries())
      .map(([label, value]) => ({ label, value: Math.round(value) }))
      .sort((a, b) => b.value - a.value);

    return {
      kpis: [
        {
          label: "Today's Appts",
          icon: 'calendar',
          metricKey: 'todayAppts',
          color: '#059669',
          value: todayAppts,
        },
        {
          label: 'Revenue',
          icon: 'wallet',
          metricKey: 'revenue',
          color: '#e11d48',
          value: revenue,
          currency,
          ...computeDelta(revenue, priorRevenue),
        },
        {
          label: 'Completed',
          icon: 'check-circle',
          metricKey: 'completedCount',
          color: '#2563eb',
          value: completedCount,
        },
        {
          label: 'Booked',
          icon: 'users',
          metricKey: 'bookedCount',
          color: '#9333ea',
          value: periodRows.length,
        },
      ],
      charts: [
        {
          id: 'stylist-revenue',
          title: 'Revenue per Stylist',
          subtitle: 'Completed appointments in period',
          type: 'bar',
          horizontal: true,
          series: [{ name: 'Revenue', dataKey: 'value', color: '#059669' }],
          data:
            stylistChart.length > 0 ? stylistChart : [{ label: '—', value: 0 }],
        },
      ],
      table: null,
    };
  }

  // noshow
  const bookedCount = periodRows.length;
  const noShowCount = periodRows.filter((r) => r.status === 'No-show').length;
  const priorBooked = priorRows.length;
  const priorNoShow = priorRows.filter((r) => r.status === 'No-show').length;
  const noShowRate =
    bookedCount > 0
      ? Number(((noShowCount / bookedCount) * 100).toFixed(1))
      : 0;
  const priorRate =
    priorBooked > 0
      ? Number(((priorNoShow / priorBooked) * 100).toFixed(1))
      : 0;

  const noShowTrend = buildTimeSeries(
    periodRows
      .filter((r) => r.status === 'No-show')
      .map((r) => ({ date: r.date })),
    window,
    () => 1,
  ).map((row) => ({ label: row.label, noShows: row.value }));

  return {
    kpis: [
      {
        label: 'No-show Rate',
        icon: 'user-x',
        metricKey: 'noShowRate',
        color: '#9333ea',
        value: noShowRate,
        ...computeDelta(noShowRate, priorRate),
      },
      {
        label: 'Booked',
        icon: 'calendar',
        metricKey: 'bookedCount',
        color: '#2563eb',
        value: bookedCount,
        ...computeDelta(bookedCount, priorBooked),
      },
      {
        label: 'No-shows',
        icon: 'user-x',
        metricKey: 'noShowCount',
        color: '#e11d48',
        value: noShowCount,
        ...computeDelta(noShowCount, priorNoShow),
      },
      {
        label: "Today's Appts",
        icon: 'calendar',
        metricKey: 'todayAppts',
        color: '#059669',
        value: todayAppts,
      },
    ],
    charts: [
      {
        id: 'noshow-trend',
        title: 'No-show Trend',
        subtitle: 'No-shows over selected period',
        type: 'line',
        series: [{ name: 'No-shows', dataKey: 'noShows', color: '#9333ea' }],
        data:
          noShowTrend.length > 0 ? noShowTrend : [{ label: '—', noShows: 0 }],
      },
    ],
    table: null,
  };
}
