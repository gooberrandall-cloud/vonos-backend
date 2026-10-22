import {
  carModelMatches,
  carModelSummary,
  carModelTokens,
  collectCarModelOptions,
  splitCarModelSegments,
} from '@vonos/types';

/**
 * carModel is free text typed in the POS, so these cases are drawn from the
 * live VISP/VSP catalogue rather than invented — the parser has to cope with
 * bracketed years, missing commas, part codes and accessory descriptions.
 */
describe('carModel parsing', () => {
  it('splits comma-separated fitment into segments', () => {
    expect(splitCarModelSegments('AVALON 2006-2010, CAMRY 2007-2011')).toEqual([
      'AVALON',
      'CAMRY',
    ]);
  });

  it('drops accessory descriptions that are not vehicle models', () => {
    expect(carModelTokens('AIR DUSTER')).toEqual([]);
    expect(carModelTokens('DIGITAL INFLATOR GAUGE')).toEqual([]);
    expect(carModelTokens('FUEL INJECTOR TESTER')).toEqual([]);
  });

  it('strips bracketed years without losing the model', () => {
    expect(
      carModelTokens(
        '4RUNNER(2018-2020) TUNDRA(2011-2014) LAND CRUISER PRADO(2015-2019)',
      ),
    ).toEqual(['4runner', 'Tundra', 'Cruiser Prado']);
  });

  it('separates models run together with only a year between them', () => {
    expect(
      carModelTokens('2010-2015 Lexus RX450h 2010-2015 Lexus RX350'),
    ).toEqual(['Rx450h', 'Rx350']);
  });

  it('keeps model designations that carry digits', () => {
    expect(carModelTokens('LEXUS ES350 2009-2012')).toEqual(['Es350']);
    expect(carModelTokens('HYUNDAI Ix35 2010-2015')).toEqual(['Ix35']);
  });

  it('drops part codes but not the model they precede', () => {
    expect(carModelTokens('CET-121/2 CAMRY 2001-2006')).toEqual(['Camry']);
    expect(
      carModelTokens('FUEL FILTER MASUMA 23300-21010 TACOMA 2005-2015'),
    ).toEqual(['Tacoma']);
  });

  it('normalises known make spellings and typos', () => {
    expect(carModelTokens('HODA CIVIC 2012-2023')).toEqual(['Civic']);
    expect(carModelTokens('MERCERDES BENZ C400 2015-2022')).toEqual(['C400']);
    expect(carModelTokens('MERCEDES BENZ M-CLASS 2005-2011')).toEqual([
      'M-Class',
    ]);
  });

  it('collapses a make repeated around the model', () => {
    expect(carModelTokens('TOYOTA HIGHLANDER TOYOTA CARS')).toEqual([
      'Highlander',
    ]);
  });

  it('builds a deduped, sorted option list across many fitment values', () => {
    const options = collectCarModelOptions([
      'CAMRY 2007-2011',
      'camry 2018-2022',
      'COROLLA 2006-2013',
      null,
      undefined,
      '',
    ]);
    expect(options).toEqual(['Camry', 'Corolla']);
  });

  it('matches a chosen model as a case-insensitive substring', () => {
    const raw = 'AVALON 2006-2010, CAMRY 2007-2011, LEXUS ES350 2009-2012';
    expect(carModelMatches(raw, 'camry')).toBe(true);
    expect(carModelMatches(raw, 'ES350')).toBe(true);
    expect(carModelMatches(raw, 'Civic')).toBe(false);
    expect(carModelMatches(raw, '')).toBe(true);
    expect(carModelMatches(null, 'camry')).toBe(false);
    expect(carModelMatches(raw, null)).toBe(true);
  });

  it('summarises a long fitment for a product card', () => {
    const summary = carModelSummary(
      'AUDI ,JEEP, MERCEDES BENZ, FORD, TOYOTA CAMRY 2001-2018',
    );
    expect(summary).toBe('AUDI · JEEP +3');
  });

  it('returns null when there is no fitment', () => {
    expect(carModelSummary(null)).toBeNull();
    expect(carModelSummary('   ')).toBeNull();
  });
});
