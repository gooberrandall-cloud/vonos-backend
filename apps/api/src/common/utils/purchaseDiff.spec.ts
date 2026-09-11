import { describe, expect, it } from '@jest/globals';
import {
  purchaseHeaderChanged,
  purchaseLinesEqual,
  sellPriceChanges,
} from './purchaseDiff';

describe('purchaseDiff', () => {
  it('detects unchanged lines', () => {
    const lines = [
      { itemId: 'a', sku: 'A', name: 'A', quantity: 2, unitCost: 100 },
    ];
    expect(purchaseLinesEqual(lines, [...lines])).toBe(true);
  });

  it('detects qty / cost line edits', () => {
    const prev = [
      { itemId: 'a', sku: 'A', name: 'A', quantity: 2, unitCost: 100 },
    ];
    const next = [
      { itemId: 'a', sku: 'A', name: 'A', quantity: 3, unitCost: 100 },
    ];
    expect(purchaseLinesEqual(prev, next)).toBe(false);
  });

  it('only returns sell-price rows that actually changed', () => {
    const prev = [
      { itemId: 'a', unitSellingPrice: 500 },
      { itemId: 'b', unitSellingPrice: 200 },
    ];
    const next = [
      { itemId: 'a', unitSellingPrice: 500 },
      { itemId: 'b', unitSellingPrice: 250 },
    ];
    expect(sellPriceChanges(prev, next)).toEqual([
      { itemId: 'b', sellPrice: 250 },
    ]);
  });

  it('detects header-only edits', () => {
    expect(
      purchaseHeaderChanged(
        {
          reference: 'PO-1',
          status: 'Received',
          supplierId: 's1',
          locationCode: 'HQ',
          dateIso: '2026-01-01T00:00:00.000Z',
          notes: null,
          paymentMethod: 'cash',
          paymentStatus: 'paid',
        },
        {
          reference: 'PO-1',
          status: 'Received',
          supplierId: 's1',
          locationCode: 'HQ',
          dateIso: '2026-01-01T00:00:00.000Z',
          notes: 'updated note',
          paymentMethod: 'cash',
          paymentStatus: 'paid',
        },
      ),
    ).toBe(true);
  });
});
