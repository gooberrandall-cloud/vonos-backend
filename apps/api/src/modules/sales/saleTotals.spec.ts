import {
  buildSaleLineRows,
  combinedTaxAmount,
  computeSaleTotal,
  lineTaxTotal,
  normalizeTaxPercent,
  orderTaxFromPersistedTax,
} from './saleTotals';

describe('saleTotals', () => {
  it('normalizes tax percentages to 0..100', () => {
    expect(normalizeTaxPercent(undefined)).toBe(0);
    expect(normalizeTaxPercent(null)).toBe(0);
    expect(normalizeTaxPercent(-5)).toBe(0);
    expect(normalizeTaxPercent(Number.NaN)).toBe(0);
    expect(normalizeTaxPercent(7.5)).toBe(7.5);
    expect(normalizeTaxPercent(150)).toBe(100);
  });

  it('persists a normalized taxPercent on each line row', () => {
    const rows = buildSaleLineRows([
      { sku: 'A', name: 'A', quantity: 2, unitPrice: 500, taxPercent: 7.5 },
      { sku: 'B', name: 'B', quantity: 1, unitPrice: 100 },
    ]);
    expect(rows[0].taxPercent).toBe(7.5);
    expect(rows[1].taxPercent).toBe(0);
    expect(rows[0].lineTotal).toBe(1000);
  });

  it('sums line VAT from line totals and percents', () => {
    const rows = [
      { lineTotal: 1000, taxPercent: 7.5 },
      { lineTotal: 200, taxPercent: 5 },
      { lineTotal: 50, taxPercent: 0 },
    ];
    expect(lineTaxTotal(rows)).toBe(75 + 10);
  });

  it('folds line VAT and order tax into the sale total', () => {
    const rows = [
      { lineTotal: 1000, taxPercent: 7.5 },
      { lineTotal: 500, taxPercent: 0 },
    ];
    // 1500 net + 75 line VAT + 200 order tax
    expect(computeSaleTotal(rows, 0, 200)).toBe(1775);
    // discount applies before tax
    expect(computeSaleTotal(rows, 300, 200)).toBe(1475);
  });

  it('clamps discounts and tax so the total never goes negative', () => {
    const rows = [{ lineTotal: 100, taxPercent: 0 }];
    expect(computeSaleTotal(rows, 500, 0)).toBe(0);
    expect(computeSaleTotal(rows, 0, -20)).toBe(100);
  });

  it('persists combined tax = order tax + line VAT', () => {
    const rows = [
      { lineTotal: 1000, taxPercent: 7.5 },
      { lineTotal: 400, taxPercent: 5 },
    ];
    expect(combinedTaxAmount(200, rows)).toBe(200 + 75 + 20);
  });

  it('round-trips a persisted combined tax back to order tax on edit', () => {
    const rows = [
      { lineTotal: 1000, taxPercent: 7.5 },
      { lineTotal: 400, taxPercent: 5 },
    ];
    const persisted = combinedTaxAmount(200, rows);
    expect(orderTaxFromPersistedTax(persisted, rows)).toBe(200);
    // legacy sale with combined tax but no line percents yet
    expect(orderTaxFromPersistedTax(275, [{ lineTotal: 1000, taxPercent: 0 }])).toBe(275);
  });
});
