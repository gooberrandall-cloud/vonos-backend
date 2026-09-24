import { describe, expect, it } from 'vitest';
import {
  excludeOpeningStockPurchasesWhere,
  isOpeningStockReference,
  OPENING_STOCK_REF_PREFIX,
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
    expect(isOpeningStockReference(null)).toBe(false);
  });

  it('excludes OS/ prefix from purchase queries', () => {
    expect(excludeOpeningStockPurchasesWhere()).toEqual({
      NOT: { reference: { startsWith: OPENING_STOCK_REF_PREFIX } },
    });
  });
});
