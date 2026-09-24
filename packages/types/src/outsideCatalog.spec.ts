import { isOutsideOrServiceCatalogItem } from './outsideCatalog';

describe('isOutsideOrServiceCatalogItem', () => {
  it('flags OT-suffixed names and categories', () => {
    expect(
      isOutsideOrServiceCatalogItem({ name: 'FIXING OF PRINT BOX OT' }),
    ).toBe(true);
    expect(
      isOutsideOrServiceCatalogItem({ name: 'AC COMPRESSOR OT' }),
    ).toBe(true);
    expect(
      isOutsideOrServiceCatalogItem({
        name: 'CUSTOM CLEARING OF GOODS',
        category: 'Other suppliers OT',
      }),
    ).toBe(true);
  });

  it('flags service phrasing without OT', () => {
    expect(
      isOutsideOrServiceCatalogItem({ name: 'FIXING OF FUSE BOX' }),
    ).toBe(true);
    expect(
      isOutsideOrServiceCatalogItem({ name: 'CLEARING OF ROTATION' }),
    ).toBe(true);
    expect(
      isOutsideOrServiceCatalogItem({
        name: 'PANEL BEAT',
        category: 'BODY WORK/PAINTING',
      }),
    ).toBe(true);
  });

  it('does not flag ordinary stock parts', () => {
    expect(
      isOutsideOrServiceCatalogItem({ name: 'COMPLETE FUSE BOX' }),
    ).toBe(false);
    expect(
      isOutsideOrServiceCatalogItem({ name: 'AIR FILTER', sku: 'AF-1' }),
    ).toBe(false);
    expect(
      isOutsideOrServiceCatalogItem({
        name: 'BRAKE PAD',
        category: 'Suspensions',
      }),
    ).toBe(false);
  });
});
