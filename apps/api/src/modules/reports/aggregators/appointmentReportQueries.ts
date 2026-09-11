import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';
import { bucketLabel, type DateWindow } from './date-utils';

export interface AppointmentKpiSnapshot {
  todayAppts: number;
  bookedCount: number;
  completedCount: number;
  revenue: number;
  noShowCount: number;
  currency: string;
}

export interface StylistRevenueRow {
  label: string;
  value: number;
}

export interface NoShowTrendRow {
  label: string;
  noShows: number;
}

export async function appointmentKpiSnapshot(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
  todayStart: Date,
  todayEnd: Date,
): Promise<AppointmentKpiSnapshot> {
  const [period, today, currencyRow] = await Promise.all([
    db.$queryRaw<
      [
        {
          booked: bigint;
          completed: bigint;
          revenue: Prisma.Decimal | null;
          no_shows: bigint;
        },
      ]
    >`
      SELECT
        COUNT(*)::bigint AS booked,
        COUNT(*) FILTER (WHERE status = 'Completed')::bigint AS completed,
        COALESCE(SUM("servicePrice") FILTER (WHERE status = 'Completed'), 0) AS revenue,
        COUNT(*) FILTER (WHERE status = 'No-show')::bigint AS no_shows
      FROM "Appointment"
      WHERE "tenantId" = ${tenantId}
        AND "deletedAt" IS NULL
        AND "startTime" >= ${window.from}
        AND "startTime" <= ${window.to}
    `,
    db.appointment.count({
      where: {
        tenantId,
        deletedAt: null,
        startTime: { gte: todayStart, lte: todayEnd },
      },
    }),
    db.appointment.findFirst({
      where: { tenantId, deletedAt: null },
      select: { currency: true },
      orderBy: { id: 'asc' },
    }),
  ]);

  const row = period[0];
  return {
    todayAppts: today,
    bookedCount: Number(row?.booked ?? 0),
    completedCount: Number(row?.completed ?? 0),
    revenue: toNumber(row?.revenue ?? 0),
    noShowCount: Number(row?.no_shows ?? 0),
    currency: currencyRow?.currency ?? 'NGN',
  };
}

export async function stylistRevenueInWindow(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<StylistRevenueRow[]> {
  const rows = await db.$queryRaw<
    Array<{ label: string; value: Prisma.Decimal | null }>
  >`
    SELECT "stylistName" AS label, COALESCE(SUM("servicePrice"), 0) AS value
    FROM "Appointment"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status = 'Completed'
      AND "startTime" >= ${from}
      AND "startTime" <= ${to}
    GROUP BY "stylistName"
    ORDER BY value DESC
  `;

  return rows.map((row) => ({
    label: row.label,
    value: Math.round(toNumber(row.value ?? 0)),
  }));
}

export async function noShowTrend(
  db: TenantScopedPrisma,
  tenantId: string,
  window: DateWindow,
): Promise<NoShowTrendRow[]> {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const unit = spanDays <= 2 ? 'hour' : spanDays <= 60 ? 'day' : 'month';

  const rows = await db.$queryRaw<Array<{ bucket: Date; count: bigint }>>`
    SELECT date_trunc(${unit}, "startTime") AS bucket, COUNT(*)::bigint AS count
    FROM "Appointment"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status = 'No-show'
      AND "startTime" >= ${window.from}
      AND "startTime" <= ${window.to}
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  return rows.map((row) => ({
    label: bucketLabel(row.bucket, spanDays),
    noShows: Number(row.count),
  }));
}

export async function todayAppointmentSummary(
  db: TenantScopedPrisma,
  tenantId: string,
  todayStart: Date,
  todayEnd: Date,
) {
  const rows = await db.$queryRaw<
    Array<{
      stylistName: string;
      hour: number;
      client: string | null;
      serviceName: string;
      status: string;
      id: string;
      startTime: Date;
    }>
  >`
    SELECT
      a.id,
      a."stylistName",
      EXTRACT(HOUR FROM a."startTime")::int AS hour,
      c.name AS client,
      a."serviceName",
      a.status::text AS status,
      a."startTime"
    FROM "Appointment" a
    LEFT JOIN "Customer" c ON c.id = a."customerId"
    WHERE a."tenantId" = ${tenantId}
      AND a."deletedAt" IS NULL
      AND a."startTime" >= ${todayStart}
      AND a."startTime" <= ${todayEnd}
    ORDER BY a."startTime" ASC
  `;

  return rows;
}

export async function totalNoShows(
  db: TenantScopedPrisma,
  tenantId: string,
): Promise<number> {
  return db.appointment.count({
    where: { tenantId, deletedAt: null, status: 'No-show' },
  });
}
