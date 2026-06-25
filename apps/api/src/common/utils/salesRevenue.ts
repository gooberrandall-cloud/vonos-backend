import type { TenantScopedPrisma } from '../prisma/prisma.service';
import { toNumber } from './serializers';
import { resolveDateWindow } from '../../modules/reports/aggregators/date-utils';

/** VISP revenue proxy: sum of completed sale totals when ledger rows are missing. */
export async function computeSalesRevenueTotal(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<{ revenue: number; currency: string }> {
  const window = resolveDateWindow(from, to);
  const [agg, sample] = await Promise.all([
    db.sale.aggregate({
      where: {
        deletedAt: null,
        status: { not: 'draft' },
        date: { gte: window.from, lte: window.to },
      },
      _sum: { total: true },
    }),
    db.sale.findFirst({
      where: {
        deletedAt: null,
        status: { not: 'draft' },
        date: { gte: window.from, lte: window.to },
      },
      select: { currency: true },
      orderBy: { date: 'desc' },
    }),
  ]);

  return {
    revenue: toNumber(agg._sum.total ?? 0),
    currency: sample?.currency ?? 'NGN',
  };
}
