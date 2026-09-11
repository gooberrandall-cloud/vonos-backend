import { describe, expect, it } from 'vitest';
import {
  locationCodesForTenantCode,
  normalizeWorkLocationToTenantCode,
  uniqueTenantCodesFromWorkLocations,
} from './workLocationTenantCodes';

describe('workLocationTenantCodes', () => {
  it('maps legacy VM/VMS onto VA', () => {
    expect(normalizeWorkLocationToTenantCode('VM')).toBe('VA');
    expect(normalizeWorkLocationToTenantCode('VMS')).toBe('VA');
    expect(normalizeWorkLocationToTenantCode('VSS')).toBe('VISP');
  });

  it('lists aliases that clear a tenant', () => {
    expect(locationCodesForTenantCode('VA').sort()).toEqual(
      ['VA', 'VM', 'VMS'].sort(),
    );
    expect(locationCodesForTenantCode('VW')).toEqual(['VW']);
    expect(locationCodesForTenantCode('VISP').sort()).toEqual(
      ['VISP', 'VSS'].sort(),
    );
  });

  it('uniques home + work locations', () => {
    expect(
      uniqueTenantCodesFromWorkLocations(['VM', 'VW', 'vw'], 'VISP'),
    ).toEqual(['VA', 'VISP', 'VW']);
  });

  it('maps full autos group entity tags onto tenant codes', () => {
    expect(
      uniqueTenantCodesFromWorkLocations(
        ['VM', 'VP', 'VISP', 'VSP', 'VW'],
        'VA',
      ),
    ).toEqual(['VA', 'VISP', 'VP', 'VSP', 'VW']);
  });
});
