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

  const sales = await db.sale.findMany({
    where: {
      deletedAt: null,
      status: { not: 'draft' },
      paymentStatus: { in: ['due', 'partial'] },
      date: { gte: window.from, lte: window.to },
    },
    select: { id: true, total: true, paymentStatus: true },
  });

  if (sales.length === 0) return 0;

  const saleIds = sales.map((sale) => sale.id);
  const paymentGroups = await db.payment.groupBy({
    by: ['saleId'],
    where: {
      deletedAt: null,
      saleId: { in: saleIds },
    },
    _sum: { amount: true },
  });

  const paidBySale = new Map(
    paymentGroups
      .filter((row) => row.saleId)
      .map((row) => [row.saleId!, toNumber(row._sum.amount ?? 0)]),
  );

  let outstanding = 0;
  for (const sale of sales) {
    const total = toNumber(sale.total);
    if (sale.paymentStatus === 'due') {
      outstanding += total;
      continue;
    }
    outstanding += Math.max(0, total - (paidBySale.get(sale.id) ?? 0));
  }

  return outstanding;
}
