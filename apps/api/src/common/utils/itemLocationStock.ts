/**
 * Helper to keep per-location stock (ItemLocationStock) in sync when item
 * quantity changes via sales, movements, and requisition transfers.
 *
 * Typed structurally so it works with both the base and tenant-extended Prisma
 * clients (and their transaction clients) without importing generated types.
 */
export interface LocationStockTx {
  itemLocationStock: {
    findFirst(args: {
      where: { itemId: string; locationCode: string; binLocation: string };
    }): Promise<{ id: string; quantity: number } | null>;
    update(args: {
      where: { id: string };
      data: { quantity: number };
    }): Promise<unknown>;
    create(args: {
      data: {
        tenantId: string;
        itemId: string;
        locationCode: string;
        binLocation: string;
        quantity: number;
      };
    }): Promise<unknown>;
  };
}

export async function adjustItemLocationStock(
  tx: LocationStockTx,
  args: {
    tenantId: string;
    itemId: string;
    locationCode?: string | null;
    binLocation?: string | null;
    delta: number;
  },
): Promise<void> {
  const locationCode = args.locationCode?.trim();
  if (!locationCode || args.delta === 0) return;
  const binLocation = args.binLocation?.trim() ?? '';

  const existing = await tx.itemLocationStock.findFirst({
    where: { itemId: args.itemId, locationCode, binLocation },
  });

  if (existing) {
    await tx.itemLocationStock.update({
      where: { id: existing.id },
      data: { quantity: Math.max(0, existing.quantity + args.delta) },
    });
  } else if (args.delta > 0) {
    await tx.itemLocationStock.create({
      data: {
        tenantId: args.tenantId,
        itemId: args.itemId,
        locationCode,
        binLocation,
        quantity: args.delta,
      },
    });
  }
}
