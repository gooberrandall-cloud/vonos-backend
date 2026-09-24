import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';

export interface JobCostSummary {
  jobCount: number;
  totalCost: number;
}

export interface JobCostMonthRow {
  label: string;
  materials: number;
  labour: number;
}

export interface JobTableRow {
  id: string;
  reference: string;
  customerName: string | null;
  status: string;
  quoteAmount: number | null;
  cost: number;
}

const materialSubquery = (tenantId: string, from: Date, to: Date) => Prisma.sql`
  SELECT jm."jobId", SUM(jm."totalCost") AS total
  FROM "JobMaterial" jm
  INNER JOIN "Job" jw ON jw.id = jm."jobId"
  WHERE jw."tenantId" = ${tenantId}
    AND jw."deletedAt" IS NULL
    AND jw."createdAt" >= ${from}
    AND jw."createdAt" <= ${to}
  GROUP BY jm."jobId"
`;

const labourSubquery = (tenantId: string, from: Date, to: Date) => Prisma.sql`
  SELECT jl."jobId", SUM(jl."totalCost") AS total
  FROM "JobLabour" jl
  INNER JOIN "Job" jw ON jw.id = jl."jobId"
  WHERE jw."tenantId" = ${tenantId}
    AND jw."deletedAt" IS NULL
    AND jw."createdAt" >= ${from}
    AND jw."createdAt" <= ${to}
  GROUP BY jl."jobId"
`;

/**
 * Global window totals without per-job LEFT JOINs (bench hotspot).
 * Materials + labour summed independently, then added — one round trip.
 */
export async function jobCostSummaryInWindow(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<JobCostSummary> {
  const pair = await jobCostSummaryPair(db, tenantId, from, to, from, to);
  return pair.current;
}

/** Current + prior job cost KPIs in a single Neon round trip. */
export async function jobCostSummaryPair(
  db: TenantScopedPrisma,
  tenantId: string,
  curFrom: Date,
  curTo: Date,
  priorFrom: Date,
  priorTo: Date,
): Promise<{ current: JobCostSummary; prior: JobCostSummary }> {
  const earliest =
    priorFrom.getTime() <= curFrom.getTime() ? priorFrom : curFrom;
  const latest = priorTo.getTime() >= curTo.getTime() ? priorTo : curTo;

  const rows = await db.$queryRaw<
    [
      {
        cur_job_count: bigint;
        prior_job_count: bigint;
        cur_materials: Prisma.Decimal | null;
        cur_labour: Prisma.Decimal | null;
        prior_materials: Prisma.Decimal | null;
        prior_labour: Prisma.Decimal | null;
      },
    ]
  >`
    WITH jobs AS (
      SELECT id, "createdAt"
      FROM "Job"
      WHERE "tenantId" = ${tenantId}
        AND "deletedAt" IS NULL
        AND "createdAt" >= ${earliest}
        AND "createdAt" <= ${latest}
    )
    SELECT
      (SELECT COUNT(*)::bigint FROM jobs
        WHERE "createdAt" >= ${curFrom} AND "createdAt" <= ${curTo}) AS cur_job_count,
      (SELECT COUNT(*)::bigint FROM jobs
        WHERE "createdAt" >= ${priorFrom} AND "createdAt" <= ${priorTo}) AS prior_job_count,
      (SELECT COALESCE(SUM(jm."totalCost"), 0)
        FROM "JobMaterial" jm
        INNER JOIN jobs j ON j.id = jm."jobId"
        WHERE j."createdAt" >= ${curFrom} AND j."createdAt" <= ${curTo}) AS cur_materials,
      (SELECT COALESCE(SUM(jl."totalCost"), 0)
        FROM "JobLabour" jl
        INNER JOIN jobs j ON j.id = jl."jobId"
        WHERE j."createdAt" >= ${curFrom} AND j."createdAt" <= ${curTo}) AS cur_labour,
      (SELECT COALESCE(SUM(jm."totalCost"), 0)
        FROM "JobMaterial" jm
        INNER JOIN jobs j ON j.id = jm."jobId"
        WHERE j."createdAt" >= ${priorFrom} AND j."createdAt" <= ${priorTo}) AS prior_materials,
      (SELECT COALESCE(SUM(jl."totalCost"), 0)
        FROM "JobLabour" jl
        INNER JOIN jobs j ON j.id = jl."jobId"
        WHERE j."createdAt" >= ${priorFrom} AND j."createdAt" <= ${priorTo}) AS prior_labour
  `;

  const row = rows[0];
  return {
    current: {
      jobCount: Number(row?.cur_job_count ?? 0),
      totalCost:
        toNumber(row?.cur_materials ?? 0) + toNumber(row?.cur_labour ?? 0),
    },
    prior: {
      jobCount: Number(row?.prior_job_count ?? 0),
      totalCost:
        toNumber(row?.prior_materials ?? 0) + toNumber(row?.prior_labour ?? 0),
    },
  };
}

export async function jobCostByMonth(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<JobCostMonthRow[]> {
  const rows = await db.$queryRaw<
    Array<{
      label: string;
      materials: Prisma.Decimal | null;
      labour: Prisma.Decimal | null;
    }>
  >`
    SELECT
      to_char(j."createdAt", 'Mon YY') AS label,
      COALESCE(SUM(COALESCE(m.total, 0)), 0) AS materials,
      COALESCE(SUM(COALESCE(l.total, 0)), 0) AS labour
    FROM "Job" j
    LEFT JOIN (${materialSubquery(tenantId, from, to)}) m ON m."jobId" = j.id
    LEFT JOIN (${labourSubquery(tenantId, from, to)}) l ON l."jobId" = j.id
    WHERE j."tenantId" = ${tenantId}
      AND j."deletedAt" IS NULL
      AND j."createdAt" >= ${from}
      AND j."createdAt" <= ${to}
    GROUP BY EXTRACT(YEAR FROM j."createdAt"), EXTRACT(MONTH FROM j."createdAt"), label
    ORDER BY EXTRACT(YEAR FROM j."createdAt"), EXTRACT(MONTH FROM j."createdAt")
  `;

  return rows.map((row) => ({
    label: row.label.trim(),
    materials: toNumber(row.materials ?? 0),
    labour: toNumber(row.labour ?? 0),
  }));
}

export async function jobTableRowsInWindow(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
  limit = 50,
): Promise<JobTableRow[]> {
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      reference: string;
      customerName: string | null;
      status: string;
      quoteAmount: Prisma.Decimal | null;
      cost: Prisma.Decimal | null;
    }>
  >`
    SELECT
      j.id,
      j.reference,
      j."customerName",
      j.status,
      j."quoteAmount",
      COALESCE(m.total, 0) + COALESCE(l.total, 0) AS cost
    FROM "Job" j
    LEFT JOIN (${materialSubquery(tenantId, from, to)}) m ON m."jobId" = j.id
    LEFT JOIN (${labourSubquery(tenantId, from, to)}) l ON l."jobId" = j.id
    WHERE j."tenantId" = ${tenantId}
      AND j."deletedAt" IS NULL
      AND j."createdAt" >= ${from}
      AND j."createdAt" <= ${to}
    ORDER BY j.id ASC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    customerName: row.customerName,
    status: row.status,
    quoteAmount: row.quoteAmount != null ? toNumber(row.quoteAmount) : null,
    cost: toNumber(row.cost ?? 0),
  }));
}

export async function deliveredTurnaroundDays(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<number[]> {
  const rows = await db.$queryRaw<Array<{ days: number | null }>>`
    SELECT
      GREATEST(
        0,
        EXTRACT(EPOCH FROM (j."updatedAt" - j."createdAt")) / 86400.0
      ) AS days
    FROM "Job" j
    WHERE j."tenantId" = ${tenantId}
      AND j."deletedAt" IS NULL
      AND j.status = 'Delivered'
      AND j."createdAt" >= ${from}
      AND j."createdAt" <= ${to}
  `;

  return rows.map((row) => Math.max(0, Math.round(row.days ?? 0)));
}

/** Bucket counts in SQL — avoids shipping one row per delivered job to Node. */
export async function deliveredTurnaroundHistogram(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<Array<{ bucket: number; count: number }>> {
  const rows = await db.$queryRaw<
    Array<{ bucket: number; count: bigint }>
  >`
    WITH days AS (
      SELECT
        GREATEST(
          0,
          ROUND(
            EXTRACT(EPOCH FROM (j."updatedAt" - j."createdAt")) / 86400.0
          )
        )::int AS d
      FROM "Job" j
      WHERE j."tenantId" = ${tenantId}
        AND j."deletedAt" IS NULL
        AND j.status = 'Delivered'
        AND j."createdAt" >= ${from}
        AND j."createdAt" <= ${to}
    )
    SELECT
      CASE
        WHEN d <= 7 THEN d
        ELSE LEAST(30, (CEIL(d / 7.0) * 7)::int)
      END AS bucket,
      COUNT(*)::bigint AS count
    FROM days
    GROUP BY 1
    ORDER BY 1
  `;

  return rows.map((row) => ({
    bucket: Number(row.bucket),
    count: Number(row.count),
  }));
}

export async function avgDeliveredTurnaroundDays(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const pair = await avgDeliveredTurnaroundPair(
    db,
    tenantId,
    from,
    to,
    from,
    to,
  );
  return pair.current;
}

/** Current + prior avg turnaround in one round trip. */
export async function avgDeliveredTurnaroundPair(
  db: TenantScopedPrisma,
  tenantId: string,
  curFrom: Date,
  curTo: Date,
  priorFrom: Date,
  priorTo: Date,
): Promise<{ current: number; prior: number }> {
  const earliest =
    priorFrom.getTime() <= curFrom.getTime() ? priorFrom : curFrom;
  const latest = priorTo.getTime() >= curTo.getTime() ? priorTo : curTo;

  const rows = await db.$queryRaw<
    [{ cur_avg: number | null; prior_avg: number | null }]
  >`
    SELECT
      AVG(days) FILTER (
        WHERE "createdAt" >= ${curFrom} AND "createdAt" <= ${curTo}
      ) AS cur_avg,
      AVG(days) FILTER (
        WHERE "createdAt" >= ${priorFrom} AND "createdAt" <= ${priorTo}
      ) AS prior_avg
    FROM (
      SELECT
        j."createdAt",
        GREATEST(
          0,
          EXTRACT(EPOCH FROM (j."updatedAt" - j."createdAt")) / 86400.0
        ) AS days
      FROM "Job" j
      WHERE j."tenantId" = ${tenantId}
        AND j."deletedAt" IS NULL
        AND j.status = 'Delivered'
        AND j."createdAt" >= ${earliest}
        AND j."createdAt" <= ${latest}
    ) d
  `;

  return {
    current: rows[0]?.cur_avg ?? 0,
    prior: rows[0]?.prior_avg ?? 0,
  };
}

export async function sumDeliveredQuoteRevenue(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const pair = await deliveredQuoteRevenuePair(
    db,
    tenantId,
    from,
    to,
    from,
    to,
  );
  return pair.current;
}

/** Current + prior delivered quote revenue + delivered counts in one round trip. */
export async function deliveredQuoteRevenuePair(
  db: TenantScopedPrisma,
  tenantId: string,
  curFrom: Date,
  curTo: Date,
  priorFrom: Date,
  priorTo: Date,
): Promise<{
  current: number;
  prior: number;
  currentDelivered: number;
  priorDelivered: number;
}> {
  const earliest =
    priorFrom.getTime() <= curFrom.getTime() ? priorFrom : curFrom;
  const latest = priorTo.getTime() >= curTo.getTime() ? priorTo : curTo;

  const rows = await db.$queryRaw<
    [
      {
        cur_revenue: Prisma.Decimal | null;
        prior_revenue: Prisma.Decimal | null;
        cur_delivered: bigint;
        prior_delivered: bigint;
      },
    ]
  >`
    SELECT
      COALESCE(SUM("quoteAmount") FILTER (
        WHERE "createdAt" >= ${curFrom} AND "createdAt" <= ${curTo}
          AND "quoteAmount" IS NOT NULL
      ), 0) AS cur_revenue,
      COALESCE(SUM("quoteAmount") FILTER (
        WHERE "createdAt" >= ${priorFrom} AND "createdAt" <= ${priorTo}
          AND "quoteAmount" IS NOT NULL
      ), 0) AS prior_revenue,
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${curFrom} AND "createdAt" <= ${curTo}
      )::bigint AS cur_delivered,
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${priorFrom} AND "createdAt" <= ${priorTo}
      )::bigint AS prior_delivered
    FROM "Job"
    WHERE "tenantId" = ${tenantId}
      AND "deletedAt" IS NULL
      AND status = 'Delivered'
      AND "createdAt" >= ${earliest}
      AND "createdAt" <= ${latest}
  `;

  const row = rows[0];
  return {
    current: toNumber(row?.cur_revenue ?? 0),
    prior: toNumber(row?.prior_revenue ?? 0),
    currentDelivered: Number(row?.cur_delivered ?? 0),
    priorDelivered: Number(row?.prior_delivered ?? 0),
  };
}
