import {
  excludeOpeningStockPurchasesWhere,
  isOpeningStockReference,
  isStockAdjustmentReference,
  OPENING_STOCK_REF_PREFIX,
  STOCK_ADJUSTMENT_REF_PREFIX,
} from './openingStockMovement';

describe('openingStockMovement', () => {
  it('detects OS/ opening-stock references only', () => {
    expect(
      isOpeningStockReference(
        'OS/MK42055 FRONT RIGHT 2014-2019 Toyota Highlander/mtvc2rk6624n',
      ),
    ).toBe(true);
    expect(isOpeningStockReference('PO-1789032292545')).toBe(false);
    expect(isOpeningStockReference('SALE-ABC-P1')).toBe(false);
    expect(isOpeningStockReference('ADJ/MK42055/abc123')).toBe(false);
    expect(isOpeningStockReference(null)).toBe(false);
  });

  it('detects ADJ/ stock-adjustment references only', () => {
    expect(isStockAdjustmentReference('ADJ/MK42055/abc123')).toBe(true);
    expect(isStockAdjustmentReference('OS/MK42055/abc123')).toBe(false);
    expect(isStockAdjustmentReference('PO-1789032292545')).toBe(false);
    expect(isStockAdjustmentReference(null)).toBe(false);
  });

  it('excludes OS/ and ADJ/ prefixes from purchase queries', () => {
    expect(excludeOpeningStockPurchasesWhere()).toEqual({
      NOT: [
        { reference: { startsWith: OPENING_STOCK_REF_PREFIX } },
        { reference: { startsWith: STOCK_ADJUSTMENT_REF_PREFIX } },
      ],
    });
  });
});
