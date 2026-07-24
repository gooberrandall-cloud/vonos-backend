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

export async function jobCostSummaryInWindow(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<JobCostSummary> {
  const rows = await db.$queryRaw<
    [{ job_count: bigint; total_cost: Prisma.Decimal | null }]
  >`
    SELECT
      COUNT(*)::bigint AS job_count,
      COALESCE(SUM(COALESCE(m.total, 0) + COALESCE(l.total, 0)), 0) AS total_cost
    FROM "Job" j
    LEFT JOIN (${materialSubquery(tenantId, from, to)}) m ON m."jobId" = j.id
    LEFT JOIN (${labourSubquery(tenantId, from, to)}) l ON l."jobId" = j.id
    WHERE j."tenantId" = ${tenantId}
      AND j."deletedAt" IS NULL
      AND j."createdAt" >= ${from}
      AND j."createdAt" <= ${to}
  `;

  const row = rows[0];
  return {
    jobCount: Number(row?.job_count ?? 0),
    totalCost: toNumber(row?.total_cost ?? 0),
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
  const rows = await db.$queryRaw<Array<{ avg_days: number | null }>>`
    SELECT
      AVG(
        GREATEST(
          0,
          EXTRACT(EPOCH FROM (j."updatedAt" - j."createdAt")) / 86400.0
        )
      ) AS avg_days
    FROM "Job" j
    WHERE j."tenantId" = ${tenantId}
      AND j."deletedAt" IS NULL
      AND j.status = 'Delivered'
      AND j."createdAt" >= ${from}
      AND j."createdAt" <= ${to}
  `;

  return rows[0]?.avg_days ?? 0;
}

export async function sumDeliveredQuoteRevenue(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const result = await db.job.aggregate({
    where: {
      tenantId,
      deletedAt: null,
      createdAt: { gte: from, lte: to },
      status: 'Delivered',
      quoteAmount: { not: null },
    },
    _sum: { quoteAmount: true },
  });

  return toNumber(result._sum.quoteAmount ?? 0);
}
