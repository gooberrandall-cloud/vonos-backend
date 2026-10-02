import {
  AUTOS_GROUP_CODES,
  OPERATIONS_GROUP_CODES,
  VAG_OVERVIEW_CODES,
  isAutosGroupCode,
  isOperationsGroupCode,
  isVagOverviewCode,
} from './group';

describe('group membership', () => {
  it('keeps only autos entities in AUTOS_GROUP_CODES', () => {
    expect([...AUTOS_GROUP_CODES]).toEqual(['VW', 'VA', 'VP', 'VISP', 'VSP']);
    expect(isAutosGroupCode('VA')).toBe(true);
    expect(isAutosGroupCode('VC')).toBe(false);
    expect(isAutosGroupCode('VS')).toBe(false);
    expect(isAutosGroupCode('VKW')).toBe(false);
  });

  it('includes Cafe in VAG overview roll-up codes', () => {
    expect([...VAG_OVERVIEW_CODES]).toEqual([
      'VW',
      'VA',
      'VP',
      'VISP',
      'VSP',
      'VC',
    ]);
    expect(isVagOverviewCode('VC')).toBe(true);
    expect(isVagOverviewCode('VA')).toBe(true);
    expect(isVagOverviewCode('VS')).toBe(false);
    expect(isVagOverviewCode('VKW')).toBe(false);
  });

  it('lists cafe / saloon / kids wear as operations mounts', () => {
    expect([...OPERATIONS_GROUP_CODES]).toEqual(['VC', 'VS', 'VKW']);
    expect(isOperationsGroupCode('VC')).toBe(true);
    expect(isOperationsGroupCode('VS')).toBe(true);
    expect(isOperationsGroupCode('VKW')).toBe(true);
    expect(isOperationsGroupCode('VW')).toBe(false);
  });
});
