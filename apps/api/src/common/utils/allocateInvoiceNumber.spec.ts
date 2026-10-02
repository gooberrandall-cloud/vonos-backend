import {
  defaultYearInvoicePrefix,
  formatInvoiceNumber,
  isTenantCodeInvoicePrefix,
  isYearInvoicePrefix,
  resolveInvoicePrefix,
} from './allocateInvoiceNumber';

describe('allocateInvoiceNumber helpers', () => {
  it('detects year prefixes with slash or hyphen', () => {
    expect(isYearInvoicePrefix('2026/')).toBe(true);
    expect(isYearInvoicePrefix('2026-')).toBe(true);
    expect(isYearInvoicePrefix('2026')).toBe(true);
    expect(isYearInvoicePrefix('INV')).toBe(false);
    expect(isYearInvoicePrefix('')).toBe(false);
  });

  it('detects tenant-code prefixes', () => {
    expect(isTenantCodeInvoicePrefix('VA')).toBe(true);
    expect(isTenantCodeInvoicePrefix('VP')).toBe(true);
    expect(isTenantCodeInvoicePrefix('VISP')).toBe(true);
    expect(isTenantCodeInvoicePrefix('INV-')).toBe(false);
    expect(isTenantCodeInvoicePrefix('2026/')).toBe(false);
  });

  it('resolves year / blank / tenant-code prefixes to current year with slash', () => {
    const year = new Date().getFullYear();
    expect(resolveInvoicePrefix('2025/')).toBe(`${year}/`);
    expect(resolveInvoicePrefix('2026-')).toBe(`${year}/`);
    expect(resolveInvoicePrefix(null)).toBe(`${year}/`);
    expect(resolveInvoicePrefix('')).toBe(`${year}/`);
    expect(resolveInvoicePrefix('VA')).toBe(`${year}/`);
    expect(resolveInvoicePrefix('VP')).toBe(`${year}/`);
    expect(resolveInvoicePrefix('INV-')).toBe('INV-');
  });

  it('formats padded sequential numbers as year/number', () => {
    const year = new Date().getFullYear();
    expect(formatInvoiceNumber('2026/', 1, 4)).toBe(`${year}/0001`);
    expect(formatInvoiceNumber('2026/', 12, 4)).toBe(`${year}/0012`);
    expect(formatInvoiceNumber(null, 1, 4)).toBe(`${year}/0001`);
    expect(formatInvoiceNumber('VP', 1, 4)).toBe(`${year}/0001`);
    expect(formatInvoiceNumber('VA', 9405, 4)).toBe(`${year}/9405`);
    expect(defaultYearInvoicePrefix()).toBe(`${year}/`);
  });
});
