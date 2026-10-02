import { Prisma } from '@prisma/client';

/** Cash-book collections posted as P&L by mistake — till already has them. */
export const CASH_BOOK_LEDGER_CATEGORIES = [
  'Customer Payment',
  'Supplier Payment',
] as const;

export function excludeCashBookLedgerWhere(): {
  category: { notIn: string[] };
} {
  return {
    category: { notIn: [...CASH_BOOK_LEDGER_CATEGORIES] },
  };
}

export const EXCLUDE_CASH_BOOK_LEDGER_SQL = Prisma.sql`
  AND category NOT IN ('Customer Payment', 'Supplier Payment')
`;
