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
      where: {
        itemId: string;
        locationCode?: string;
        binLocation?: string;
      };
      orderBy?: { quantity: 'desc' };
    }): Promise<{
      id: string;
      quantity: number;
      locationCode: string;
      binLocation: string;
    } | null>;
    findMany(args: {
      where: { itemId: string };
      select?: { quantity: true };
    }): Promise<Array<{ quantity: number }>>;
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

/** Sum of per-location rows — used to heal Item.quantity when header is stale. */
export async function sumItemLocationStock(
  tx: LocationStockTx,
  itemId: string,
): Promise<number> {
  const rows = await tx.itemLocationStock.findMany({
    where: { itemId },
    select: { quantity: true },
  });
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

/**
 * Effective on-hand for stock checks: max(header qty, location sum).
 * Location rows are often edited independently; header can lag at 0 while
 * bins still show stock (false "insufficient" / "0 left" on convert).
 */
export async function effectiveItemOnHand(
  tx: LocationStockTx,
  itemId: string,
  headerQuantity: number,
): Promise<number> {
  const locSum = await sumItemLocationStock(tx, itemId);
  return Math.max(headerQuantity, locSum);
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
  if (args.delta === 0) return;

  const preferredLocation = args.locationCode?.trim() || null;
  const preferredBin = args.binLocation?.trim() ?? '';

  if (args.delta > 0) {
    if (!preferredLocation) return;
    const existing = await tx.itemLocationStock.findFirst({
      where: {
        itemId: args.itemId,
        locationCode: preferredLocation,
        binLocation: preferredBin,
      },
    });
    if (existing) {
      await tx.itemLocationStock.update({
        where: { id: existing.id },
        data: { quantity: existing.quantity + args.delta },
      });
      return;
    }
    await tx.itemLocationStock.create({
      data: {
        tenantId: args.tenantId,
        itemId: args.itemId,
        locationCode: preferredLocation,
        binLocation: preferredBin,
        quantity: args.delta,
      },
    });
    return;
  }

  // Outbound: prefer sale/item location, else deduct from the fullest bin
  // so location rows actually write off when header qty falls.
  let remaining = Math.abs(args.delta);

  if (preferredLocation) {
    const atPreferred = await tx.itemLocationStock.findFirst({
      where: {
        itemId: args.itemId,
        locationCode: preferredLocation,
        binLocation: preferredBin,
      },
    });
    if (atPreferred && atPreferred.quantity > 0) {
      const take = Math.min(remaining, atPreferred.quantity);
      await tx.itemLocationStock.update({
        where: { id: atPreferred.id },
        data: { quantity: atPreferred.quantity - take },
      });
      remaining -= take;
    }
  }

  while (remaining > 0) {
    const next = await tx.itemLocationStock.findFirst({
      where: { itemId: args.itemId },
      orderBy: { quantity: 'desc' },
    });
    if (!next || next.quantity <= 0) break;
    const take = Math.min(remaining, next.quantity);
    await tx.itemLocationStock.update({
      where: { id: next.id },
      data: { quantity: next.quantity - take },
    });
    remaining -= take;
  }
}
