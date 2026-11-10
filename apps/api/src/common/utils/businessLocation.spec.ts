import {
  assertBusinessLocation,
  assertProductStockLocation,
  defaultEntityOwnLocationCode,
} from './businessLocation';

const vispConfig = {
  code: 'VISP',
  businessLocations: [
    { code: 'VISP', name: 'Vonos Institute Spare Parts' },
  ],
};

describe('product vs sale location validation', () => {
  it('lets product create/edit omit a location', () => {
    expect(assertProductStockLocation(vispConfig, undefined)).toBeNull();
    expect(assertProductStockLocation(vispConfig, '')).toBeNull();
    expect(assertProductStockLocation(vispConfig, '   ')).toBeNull();
  });

  it('accepts this tenant product home on product writes', () => {
    expect(assertProductStockLocation(vispConfig, 'VISP')).toBe('VISP');
  });

  it('remaps legacy / sister codes onto this tenant product home', () => {
    expect(assertProductStockLocation(vispConfig, 'VW')).toBe('VISP');
    expect(assertProductStockLocation(vispConfig, 'VSP')).toBe('VISP');
    expect(assertProductStockLocation(vispConfig, 'visp')).toBe('VISP');
    expect(assertProductStockLocation(vispConfig, 'BL0001')).toBe('VISP');
    expect(assertProductStockLocation(vispConfig, 'XYZ')).toBe('VISP');
  });

  it('rejects unknown product stock locations when tenant has no product home', () => {
    const cafeConfig = {
      code: 'VC',
      businessLocations: [{ code: 'BL0001', name: 'Vonos Cafe' }],
    };
    expect(assertProductStockLocation(cafeConfig, 'BL0001')).toBe('BL0001');
    expect(() => assertProductStockLocation(cafeConfig, 'VW')).toThrow(
      /Unknown business location/,
    );
  });

  it('still requires a location on sale / expense writes', () => {
    expect(() => assertBusinessLocation(vispConfig, undefined)).toThrow(
      /Business location is required/,
    );
    expect(assertBusinessLocation(vispConfig, 'VISP')).toBe('VISP');
  });
});

describe('defaultEntityOwnLocationCode', () => {
  it('returns null when the entity has no locations', () => {
    expect(defaultEntityOwnLocationCode({ code: 'ZZ' })).toBeNull();
    expect(defaultEntityOwnLocationCode({})).toBeNull();
  });

  it("falls back to the tenant's single branch (saloon BL0003)", () => {
    expect(
      defaultEntityOwnLocationCode({
        code: 'VS',
        businessLocations: [{ code: 'BL0003', name: 'Vonos saloon' }],
      }),
    ).toBe('BL0003');
    // Preset fallback: saloon config without explicit businessLocations.
    expect(defaultEntityOwnLocationCode({ code: 'VS' })).toBe('BL0003');
  });

  it('prefers the branch matching the tenant code over the first in the list', () => {
    expect(
      defaultEntityOwnLocationCode({
        code: 'VW',
        businessLocations: [
          { code: 'BL0009', name: 'Annex' },
          { code: 'VW', name: 'Vonos Warehouse' },
        ],
      }),
    ).toBe('VW');
  });

  it('ignores sister-entity branches when picking the default', () => {
    expect(
      defaultEntityOwnLocationCode({
        code: 'VA',
        businessLocations: [
          { code: 'VW', name: 'Vonos Warehouse' },
          { code: 'VA', name: 'Vonos Mechanic' },
        ],
      }),
    ).toBe('VA');
  });
});
