import {
  assertBusinessLocation,
  assertProductStockLocation,
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
