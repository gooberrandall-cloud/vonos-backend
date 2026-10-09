import { describe, expect, it } from '@jest/globals';
import {
  CASH_BOOK_LEDGER_CATEGORIES,
  excludeCashBookLedgerWhere,
} from './ledgerCashBook';

describe('ledgerCashBook', () => {
  it('lists Customer and Supplier Payment as cash-book categories', () => {
    expect([...CASH_BOOK_LEDGER_CATEGORIES]).toEqual([
      'Customer Payment',
      'Supplier Payment',
    ]);
  });

  it('builds a Prisma notIn filter for those categories', () => {
    expect(excludeCashBookLedgerWhere()).toEqual({
      category: { notIn: ['Customer Payment', 'Supplier Payment'] },
    });
  });
});
