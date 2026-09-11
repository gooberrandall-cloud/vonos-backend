import { describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { buildLedgerSummaryFromGroups } from './ledgerAggregates';
import { excludeCashBookLedgerWhere } from './ledgerCashBook';

describe('finance summary building blocks', () => {
  it('excludes cash-book categories from P&L-style filters', () => {
    expect(excludeCashBookLedgerWhere().category.notIn).toEqual(
      expect.arrayContaining(['Customer Payment', 'Supplier Payment']),
    );
  });

  it('folds cost + expense into costs for KPI net', () => {
    const summary = buildLedgerSummaryFromGroups(
      [
        { type: 'revenue', _sum: { amount: new Prisma.Decimal(100) } },
        { type: 'cost', _sum: { amount: new Prisma.Decimal(40) } },
        { type: 'expense', _sum: { amount: new Prisma.Decimal(10) } },
      ],
      'NGN',
    );
    expect(summary.revenue).toBe(100);
    expect(summary.costs).toBe(50);
    expect(summary.net).toBe(50);
    expect(summary.currency).toBe('NGN');
  });
});
