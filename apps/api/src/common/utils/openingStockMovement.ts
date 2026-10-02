import { Prisma } from '@prisma/client';

/** Opening-stock receipts use `OS/{sku}/{id}` — stock history, not purchases. */
export const OPENING_STOCK_REF_PREFIX = 'OS/' as const;

/** Manual stock corrections use `ADJ/{sku}/{id}` — stock history, not purchases. */
export const STOCK_ADJUSTMENT_REF_PREFIX = 'ADJ/' as const;

/** Movement references that record stock truth but are never supplier purchases. */
const NON_PURCHASE_REF_PREFIXES = [
  OPENING_STOCK_REF_PREFIX,
  STOCK_ADJUSTMENT_REF_PREFIX,
] as const;

export function isOpeningStockReference(
  reference: string | null | undefined,
): boolean {
  return Boolean(reference?.startsWith(OPENING_STOCK_REF_PREFIX));
}

export function isStockAdjustmentReference(
  reference: string | null | undefined,
): boolean {
  return Boolean(reference?.startsWith(STOCK_ADJUSTMENT_REF_PREFIX));
}

/** Prisma `where` fragment: hide opening stock + adjustments from purchase lists. */
export function excludeOpeningStockPurchasesWhere(): {
  NOT: Array<{ reference: { startsWith: string } }>;
} {
  return {
    NOT: NON_PURCHASE_REF_PREFIXES.map((prefix) => ({
      reference: { startsWith: prefix },
    })),
  };
}

/** Raw-SQL counterpart for `$queryRaw` inbound purchase reports. */
export function excludeOpeningStockPurchasesSql(): Prisma.Sql {
  return Prisma.sql`AND sm.reference NOT LIKE ${`${OPENING_STOCK_REF_PREFIX}%`} AND sm.reference NOT LIKE ${`${STOCK_ADJUSTMENT_REF_PREFIX}%`}`;
}
