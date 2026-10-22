import { shouldAdjustLocalItemStock } from './localStockPolicy';

describe('shouldAdjustLocalItemStock', () => {
  it('skips VA and VP tenants regardless of item', () => {
    expect(shouldAdjustLocalItemStock({ code: 'VA' }, { sku: 'PART-1' })).toBe(
      false,
    );
    expect(shouldAdjustLocalItemStock({ code: 'vp' }, { sku: 'PART-1' })).toBe(
      false,
    );
  });

  it('skips job-archetype tenants', () => {
    expect(
      shouldAdjustLocalItemStock(
        { code: 'VM', archetype: 'job' },
        { sku: 'PART-1' },
      ),
    ).toBe(false);
  });

  it('tracks stock for warehouse and retail catalog tenants', () => {
    expect(shouldAdjustLocalItemStock({ code: 'VW' }, { sku: 'PART-1' })).toBe(
      true,
    );
    expect(
      shouldAdjustLocalItemStock({ code: 'VISP' }, { sku: 'PART-1' }),
    ).toBe(true);
    expect(
      shouldAdjustLocalItemStock({ code: 'VSP' }, { sku: '04152-31090' }),
    ).toBe(true);
  });

  it('skips OT / labour lines even on stock-holding tenants', () => {
    expect(
      shouldAdjustLocalItemStock(
        { code: 'VW' },
        { name: 'FIXING OF PRINT BOX OT' },
      ),
    ).toBe(false);
    expect(
      shouldAdjustLocalItemStock(
        { code: 'VW' },
        { name: 'AIR FILTER', sku: 'AF-1' },
      ),
    ).toBe(true);
  });
});
