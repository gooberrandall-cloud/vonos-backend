import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';
import { inWindow, resolveDateWindow, type DateWindow } from './date-utils';

export interface NormalizedJobMaterial {
  name: string;
  quantity: number;
  cost: number;
  itemId: string | null;
}

export interface NormalizedJobSale {
  id: string;
  reference: string;
  date: Date;
  revenue: number;
  directCost: number;
  customerName: string;
  locationCode: string | null;
  staffName: string | null;
  materials: NormalizedJobMaterial[];
  labourCost: number;
}

export interface JobReportContext {
  window: DateWindow;
  periodJobs: NormalizedJobSale[];
  currency: string;
}

/** Safety cap for row-level job graphs (all-time detail is truncated). */
export const JOB_REPORT_ROW_CAP = 2_000;

function jobRevenue(
  invoiceAmount: unknown,
  quoteAmount: unknown,
): number {
  const invoice = invoiceAmount != null ? toNumber(invoiceAmount) : 0;
  if (invoice > 0) return invoice;
  return quoteAmount != null ? toNumber(quoteAmount) : 0;
}

export async function loadJobReportContext(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<JobReportContext> {
  const window = resolveDateWindow(from, to);

  const jobs = await db.job.findMany({
    where: {
      deletedAt: null,
      status: 'Delivered',
      updatedAt: { gte: window.from, lte: window.to },
      // Job-linked sales own the commercial revenue — avoid double-count in P&L.
      sales: { none: { deletedAt: null } },
    },
    select: {
      id: true,
      reference: true,
      updatedAt: true,
      invoiceAmount: true,
      quoteAmount: true,
      customerName: true,
      locationCode: true,
      createdByName: true,
      customer: { select: { name: true } },
      materials: {
        select: {
          name: true,
          quantity: true,
          totalCost: true,
          itemId: true,
        },
      },
      labourEntries: { select: { totalCost: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: JOB_REPORT_ROW_CAP,
  });

  const periodJobs: NormalizedJobSale[] = jobs
    .map((job) => {
      const materials = job.materials.map((line) => ({
        name: line.name,
        quantity: toNumber(line.quantity),
        cost: toNumber(line.totalCost),
        itemId: line.itemId,
      }));
      const materialCost = materials.reduce((sum, line) => sum + line.cost, 0);
      const labourCost = job.labourEntries.reduce(
        (sum, line) => sum + toNumber(line.totalCost),
        0,
      );
      const directCost = materialCost + labourCost;
      const revenue = jobRevenue(job.invoiceAmount, job.quoteAmount);

      return {
        id: job.id,
        reference: job.reference,
        date: job.updatedAt,
        revenue,
        directCost,
        customerName:
          job.customer?.name?.trim() ||
          job.customerName?.trim() ||
          'Walk-in',
        locationCode: job.locationCode,
        staffName: job.createdByName,
        materials,
        labourCost,
      };
    })
    .filter((job) => job.revenue > 0 || job.directCost > 0);

  return {
    window,
    periodJobs: periodJobs.filter((job) => inWindow(job.date, window)),
    currency: 'NGN',
  };
}

/** SQL aggregate — no job graph load. Used by P&L summary / shell. */
export async function computeJobRevenueTotal(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<{ revenue: number; directCost: number }> {
  const window = resolveDateWindow(from, to);

  const rows = await db.$queryRaw<
    [{ revenue: Prisma.Decimal | null; direct_cost: Prisma.Decimal | null }]
  >`
    SELECT
      COALESCE(SUM(
        CASE
          WHEN j."invoiceAmount" IS NOT NULL AND j."invoiceAmount" > 0
            THEN j."invoiceAmount"
          ELSE COALESCE(j."quoteAmount", 0)
        END
      ), 0) AS revenue,
      COALESCE(SUM(COALESCE(m.total, 0) + COALESCE(l.total, 0)), 0) AS direct_cost
    FROM "Job" j
    LEFT JOIN (
      SELECT jm."jobId", SUM(jm."totalCost") AS total
      FROM "JobMaterial" jm
      INNER JOIN "Job" j2 ON j2.id = jm."jobId"
      WHERE j2."tenantId" = ${tenantId}
        AND j2."deletedAt" IS NULL
        AND j2.status = 'Delivered'
        AND j2."updatedAt" >= ${window.from}
        AND j2."updatedAt" <= ${window.to}
      GROUP BY jm."jobId"
    ) m ON m."jobId" = j.id
    LEFT JOIN (
      SELECT jl."jobId", SUM(jl."totalCost") AS total
      FROM "JobLabour" jl
      INNER JOIN "Job" j3 ON j3.id = jl."jobId"
      WHERE j3."tenantId" = ${tenantId}
        AND j3."deletedAt" IS NULL
        AND j3.status = 'Delivered'
        AND j3."updatedAt" >= ${window.from}
        AND j3."updatedAt" <= ${window.to}
      GROUP BY jl."jobId"
    ) l ON l."jobId" = j.id
    WHERE j."tenantId" = ${tenantId}
      AND j."deletedAt" IS NULL
      AND j.status = 'Delivered'
      AND j."updatedAt" >= ${window.from}
      AND j."updatedAt" <= ${window.to}
      AND NOT EXISTS (
        SELECT 1 FROM "Sale" s
        WHERE s."jobId" = j.id
          AND s."deletedAt" IS NULL
      )
  `;

  return {
    revenue: toNumber(rows[0]?.revenue ?? 0),
    directCost: toNumber(rows[0]?.direct_cost ?? 0),
  };
}
