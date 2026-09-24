import type { LedgerSummary } from '@vonos/types';
import type { TenantScopedPrisma } from '../prisma/prisma.service';
import { resolveDateWindow } from '../../modules/reports/aggregators/date-utils';
import { sumDailyFinanceRollup } from './dailyFinanceRollup';
import {
  buildLedgerSummaryFromGroups,
  ledgerDateFilter,
} from './ledgerAggregates';
import { excludeCashBookLedgerWhere } from './ledgerCashBook';
import { computeOutstandingReceivables } from './outstandingReceivables';
import { computeSalesRevenueTotal } from './salesRevenue';

/**
 * Single source for Finance KPI summary (and anything that should match it).
 * Basis: accrual document totals via rollup / ledger (cash-book payment
 * categories excluded). Revenue fallback = finalized sales only (no quotations).
 */
export async function computeFinanceSummary(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<LedgerSummary> {
  const window = resolveDateWindow(from, to);
  const dateFilter = ledgerDateFilter(from, to);

  const rollup = await sumDailyFinanceRollup(
    db,
    tenantId,
    window.from,
    window.to,
  );
  const useRollup =
    rollup.revenue > 0 || rollup.costs > 0 || rollup.expenses > 0;

  const [currencyRow, outstanding, groups] = await Promise.all([
    db.ledgerEntry.findFirst({
      where: { tenantId, deletedAt: null, ...dateFilter },
      select: { currency: true },
      orderBy: { date: 'desc' },
    }),
    computeOutstandingReceivables(db, from, to),
    useRollup
      ? Promise.resolve(null)
      : db.ledgerEntry.groupBy({
          by: ['type'],
          where: {
            tenantId,
            deletedAt: null,
            ...excludeCashBookLedgerWhere(),
            ...dateFilter,
          },
          _sum: { amount: true },
        }),
  ]);

  const summary = useRollup
    ? {
        revenue: rollup.revenue,
        costs: rollup.costs + rollup.expenses,
        net: rollup.net,
        currency: currencyRow?.currency ?? 'NGN',
        outstanding: 0,
      }
    : buildLedgerSummaryFromGroups(
        (groups ?? []).map((group) => ({
          type: group.type,
          _sum: { amount: group._sum.amount },
        })),
        currencyRow?.currency ?? 'NGN',
      );

  summary.outstanding = outstanding;

  if (summary.revenue === 0) {
    const salesRevenue = await computeSalesRevenueTotal(db, from, to);
    if (salesRevenue.revenue > 0) {
      summary.revenue = salesRevenue.revenue;
      summary.currency = salesRevenue.currency;
      summary.net = salesRevenue.revenue - summary.costs;
    }
  } else {
    summary.net = summary.revenue - summary.costs;
  }

  return summary;
}
