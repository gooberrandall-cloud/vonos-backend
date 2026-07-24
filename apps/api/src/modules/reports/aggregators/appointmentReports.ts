import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { computeDelta, priorWindow, resolveDateWindow, asChartData } from './date-utils';
import {
  appointmentKpiSnapshot,
  noShowTrend,
  stylistRevenueInWindow,
} from './appointmentReportQueries';

type AppointmentTab = 'stylist' | 'noshow';

export async function buildAppointmentReports(
  db: TenantScopedPrisma,
  tenantId: string,
  tab: AppointmentTab,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const [period, priorPeriod] = await Promise.all([
    appointmentKpiSnapshot(db, tenantId, window, todayStart, todayEnd),
    appointmentKpiSnapshot(db, tenantId, prior, todayStart, todayEnd),
  ]);

  const { currency } = period;

  if (tab === 'stylist') {
    const stylistChart = await stylistRevenueInWindow(
      db,
      tenantId,
      window.from,
      window.to,
    );

    return {
      kpis: [
        {
          label: "Today's Appts",
          icon: 'calendar',
          metricKey: 'todayAppts',
          color: '#059669',
          value: period.todayAppts,
        },
        {
          label: 'Revenue',
          icon: 'wallet',
          metricKey: 'revenue',
          color: '#e11d48',
          value: period.revenue,
          currency,
          ...computeDelta(period.revenue, priorPeriod.revenue),
        },
        {
          label: 'Completed',
          icon: 'check-circle',
          metricKey: 'completedCount',
          color: '#2563eb',
          value: period.completedCount,
        },
        {
          label: 'Booked',
          icon: 'users',
          metricKey: 'bookedCount',
          color: '#9333ea',
          value: period.bookedCount,
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
            stylistChart.length > 0
              ? asChartData(stylistChart)
              : asChartData([{ label: '—', value: 0 }]),
        },
      ],
      table: null,
    };
  }

  const noShowTrendData = await noShowTrend(db, tenantId, window);
  const bookedCount = period.bookedCount;
  const noShowCount = period.noShowCount;
  const priorBooked = priorPeriod.bookedCount;
  const priorNoShow = priorPeriod.noShowCount;
  const noShowRate =
    bookedCount > 0 ? Number(((noShowCount / bookedCount) * 100).toFixed(1)) : 0;
  const priorRate =
    priorBooked > 0
      ? Number(((priorNoShow / priorBooked) * 100).toFixed(1))
      : 0;

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
        value: period.todayAppts,
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
          noShowTrendData.length > 0
            ? asChartData(noShowTrendData)
            : asChartData([{ label: '—', noShows: 0 }]),
      },
    ],
    table: null,
  };
}
