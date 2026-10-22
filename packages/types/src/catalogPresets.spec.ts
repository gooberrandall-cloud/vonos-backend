import {
  isGroupStockConsumerTenant,
  isPriceCatalogOnlyTenant,
} from './catalogPresets';

describe('price-catalog tenants (VA / VP)', () => {
  it('treats VA and VP as group stock consumers', () => {
    expect(isGroupStockConsumerTenant('VA')).toBe(true);
    expect(isGroupStockConsumerTenant('vp')).toBe(true);
    expect(isGroupStockConsumerTenant('VW')).toBe(false);
    expect(isGroupStockConsumerTenant('VISP')).toBe(false);
    expect(isGroupStockConsumerTenant('VSP')).toBe(false);
  });

  it('marks VA/VP as price-catalog only regardless of archetype', () => {
    expect(isPriceCatalogOnlyTenant('VA')).toBe(true);
    expect(isPriceCatalogOnlyTenant('VP', 'stock')).toBe(true);
    expect(isPriceCatalogOnlyTenant('VA', null)).toBe(true);
  });

  it('marks job archetype as price-catalog only for other codes', () => {
    expect(isPriceCatalogOnlyTenant('VM', 'job')).toBe(true);
    expect(isPriceCatalogOnlyTenant('VW', 'stock')).toBe(false);
    expect(isPriceCatalogOnlyTenant('VSP', 'transaction')).toBe(false);
  });
});

describe('catalog location presets (VS / VKW)', () => {
  it('provides a default business location for saloon and kids wear', async () => {
    const { catalogPresetsForCode } = await import('./catalogPresets');
    expect(catalogPresetsForCode('VS').businessLocations).toEqual([
      { code: 'BL0003', name: 'Vonos saloon' },
    ]);
    expect(catalogPresetsForCode('VKW').businessLocations).toEqual([
      { code: 'VKW', name: 'Vonos Kids Wear' },
    ]);
  });
});
