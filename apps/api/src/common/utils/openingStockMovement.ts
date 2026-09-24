import { Prisma } from '@prisma/client';

/** Opening-stock receipts use `OS/{sku}/{id}` — stock history, not purchases. */
export const OPENING_STOCK_REF_PREFIX = 'OS/' as const;

export function isOpeningStockReference(
  reference: string | null | undefined,
): boolean {
  return Boolean(reference?.startsWith(OPENING_STOCK_REF_PREFIX));
}

/** Prisma `where` fragment: hide opening stock from purchase / inbound lists. */
export function excludeOpeningStockPurchasesWhere(): {
  NOT: { reference: { startsWith: typeof OPENING_STOCK_REF_PREFIX } };
} {
  return { NOT: { reference: { startsWith: OPENING_STOCK_REF_PREFIX } } };
}

/** Raw-SQL counterpart for `$queryRaw` inbound purchase reports. */
export function excludeOpeningStockPurchasesSql(): Prisma.Sql {
  return Prisma.sql`AND sm.reference NOT LIKE ${`${OPENING_STOCK_REF_PREFIX}%`}`;
}
