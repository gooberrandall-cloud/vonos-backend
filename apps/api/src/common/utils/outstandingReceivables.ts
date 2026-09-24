import type { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../prisma/prisma.service';
import { toNumber } from './serializers';
import { resolveDateWindow } from '../../modules/reports/aggregators/date-utils';

/** Uncollected sale balances (due + partial minus recorded payments). */
export async function computeOutstandingReceivables(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<number> {
  const window = resolveDateWindow(from, to);

  // Use cached Sale.totalPaid — avoid full Payment table aggregate join.
  const rows = await db.$queryRaw<[{ outstanding: Prisma.Decimal | null }]>`
    SELECT COALESCE(SUM(GREATEST(s.total - s."totalPaid", 0)), 0) AS outstanding
    FROM "Sale" s
    WHERE s."deletedAt" IS NULL
      AND s.status NOT IN ('draft', 'quotation')
      AND s."paymentStatus" IN ('due', 'partial')
      AND s.date >= ${window.from}
      AND s.date <= ${window.to}
  `;

  return Math.max(0, toNumber(rows[0]?.outstanding ?? 0));
}

/** All-time customer due — balance sheet snapshot (not period-scoped). */
export async function computeAllTimeOutstandingReceivables(
  db: TenantScopedPrisma,
): Promise<number> {
  const rows = await db.$queryRaw<[{ outstanding: Prisma.Decimal | null }]>`
    SELECT COALESCE(SUM(GREATEST(s.total - s."totalPaid", 0)), 0) AS outstanding
    FROM "Sale" s
    WHERE s."deletedAt" IS NULL
      AND s.status NOT IN ('draft', 'quotation')
      AND s."paymentStatus" IN ('due', 'partial')
  `;

  return Math.max(0, toNumber(rows[0]?.outstanding ?? 0));
}
