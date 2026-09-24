import {
  inboundReceiptStockDelta,
  movementLineRollups,
  shouldApplyInboundQty,
  shouldApplyOutboundQty,
} from './stockQuantity';

describe('stockQuantity', () => {
  it('applies inbound qty only when moving into Received', () => {
    expect(shouldApplyInboundQty('Ordered', 'Received')).toBe(true);
    expect(shouldApplyInboundQty('Pending', 'Received')).toBe(true);
    expect(shouldApplyInboundQty('Received', 'Received')).toBe(false);
    expect(shouldApplyInboundQty('Ordered', 'Ordered')).toBe(false);
  });

  it('applies outbound qty only on first ship/deliver', () => {
    expect(shouldApplyOutboundQty('Pending', 'Shipped')).toBe(true);
    expect(shouldApplyOutboundQty('Shipped', 'Delivered')).toBe(false);
    expect(shouldApplyOutboundQty('Delivered', 'Shipped')).toBe(false);
  });

  it('uses net qty delta when a Received purchase stays Received', () => {
    const prev = [
      { itemId: 'a', sku: 'A', name: 'A', quantity: 10 },
    ];
    const next = [
      { itemId: 'a', sku: 'A', name: 'A', quantity: 10 },
    ];
    expect(
      inboundReceiptStockDelta({
        wasReceived: true,
        willReceive: true,
        prevLines: prev,
        nextLines: next,
      }),
    ).toEqual(new Map());
  });

  it('applies net increase when Received purchase qty rises', () => {
    expect(
      inboundReceiptStockDelta({
        wasReceived: true,
        willReceive: true,
        prevLines: [{ itemId: 'a', sku: 'A', name: 'A', quantity: 10 }],
        nextLines: [{ itemId: 'a', sku: 'A', name: 'A', quantity: 12 }],
      }),
    ).toEqual(new Map([['a', 2]]));
  });

  it('reverses receipt when status leaves Received', () => {
    expect(
      inboundReceiptStockDelta({
        wasReceived: true,
        willReceive: false,
        prevLines: [{ itemId: 'a', sku: 'A', name: 'A', quantity: 8 }],
        nextLines: [{ itemId: 'a', sku: 'A', name: 'A', quantity: 8 }],
      }),
    ).toEqual(new Map([['a', -8]]));
  });

  it('rolls up line count and discounted totals', () => {
    expect(
      movementLineRollups([
        { itemId: 'a', sku: 'A', name: 'A', quantity: 2, unitCost: 100 },
        {
          itemId: 'b',
          sku: 'B',
          name: 'B',
          quantity: 1,
          unitCost: 50,
          discountPercent: 10,
        },
      ]),
    ).toEqual({ itemCount: 2, grandTotal: 245 });
  });
});
