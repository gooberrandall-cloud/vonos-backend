import { describe, expect, it } from 'vitest';
import {
  adjustItemLocationStock,
  effectiveItemOnHand,
  sumItemLocationStock,
  type LocationStockTx,
} from './itemLocationStock';

function mockTx(rows: Array<{ id: string; quantity: number; locationCode: string; binLocation: string }>): LocationStockTx {
  const store = rows.map((r) => ({ ...r }));
  return {
    itemLocationStock: {
      async findFirst(args) {
        const where = args.where;
        let matches = store.filter((r) => r.id && true);
        if (where.itemId) {
          // itemId filtered by caller only having one item in tests
        }
        if (where.locationCode != null) {
          matches = matches.filter((r) => r.locationCode === where.locationCode);
        }
        if (where.binLocation != null) {
          matches = matches.filter((r) => r.binLocation === where.binLocation);
        }
        if (args.orderBy?.quantity === 'desc') {
          matches = [...matches].sort((a, b) => b.quantity - a.quantity);
        }
        return matches[0] ?? null;
      },
      async findMany() {
        return store.map((r) => ({ quantity: r.quantity }));
      },
      async update(args) {
        const row = store.find((r) => r.id === args.where.id);
        if (row && typeof args.data.quantity === 'number') {
          row.quantity = args.data.quantity;
        }
        return row;
      },
      async create(args) {
        const row = {
          id: `new-${store.length}`,
          quantity: args.data.quantity,
          locationCode: args.data.locationCode,
          binLocation: args.data.binLocation,
        };
        store.push(row);
        return row;
      },
    },
  };
}

describe('itemLocationStock', () => {
  it('effective on-hand prefers location sum when header is stale', async () => {
    const tx = mockTx([
      { id: 'a', quantity: 4, locationCode: 'BL1', binLocation: '' },
      { id: 'b', quantity: 6, locationCode: 'BL2', binLocation: '' },
    ]);
    expect(await sumItemLocationStock(tx, 'item-1')).toBe(10);
    expect(await effectiveItemOnHand(tx, 'item-1', 0)).toBe(10);
    expect(await effectiveItemOnHand(tx, 'item-1', 12)).toBe(12);
  });

  it('outbound deducts preferred location then fullest bins', async () => {
    const tx = mockTx([
      { id: 'a', quantity: 2, locationCode: 'BL1', binLocation: '' },
      { id: 'b', quantity: 8, locationCode: 'BL2', binLocation: '' },
    ]);
    await adjustItemLocationStock(tx, {
      tenantId: 't1',
      itemId: 'item-1',
      locationCode: 'BL1',
      binLocation: '',
      delta: -5,
    });
    const sums = await tx.itemLocationStock.findMany({
      where: { itemId: 'item-1' },
      select: { quantity: true },
    });
    expect(sums.reduce((s, r) => s + r.quantity, 0)).toBe(5);
  });
});
