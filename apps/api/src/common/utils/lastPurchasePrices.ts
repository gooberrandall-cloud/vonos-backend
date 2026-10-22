import type { Item } from '@vonos/types';
import type { Prisma } from '@prisma/client';
import { toNumber } from '../utils/serializers';
import { excludeOpeningStockPurchasesWhere } from './openingStockMovement';

type Db = {
  stockMovement: {
    findMany: (args: {
      where: Prisma.StockMovementWhereInput;
      orderBy: Prisma.StockMovementOrderByWithRelationInput[];
      select: { lines: true };
      take?: number;
    }) => Promise<Array<{ lines: Prisma.JsonValue }>>;
  };
};

function lineUnitCost(line: Record<string, unknown>): number | null {
  const raw = line.unitCost;
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Overlay the most recent inbound unitCost onto list rows (by itemId, then SKU).
 * Used so HQ6 Products shows last purchase price even when Item.costPrice is stale.
 *
 * Fast path: if every row already has a stored cost (normal after backfill), skip
 * the inbound scan — that scan was the main cost of each catalog page flip.
 */
export async function applyLastPurchasePrices(
  db: Db,
  tenantId: string,
  items: Item[],
): Promise<Item[]> {
  if (items.length === 0) return items;

  const needsOverlay = items.filter(
    (row) => row.costPrice == null || row.costPrice <= 0,
  );
  if (needsOverlay.length === 0) return items;

  const skuSet = new Set(needsOverlay.map((row) => row.sku));
  const idSet = new Set(needsOverlay.map((row) => row.id));

  const movements = await db.stockMovement.findMany({
    where: {
      tenantId,
      type: 'inbound',
      deletedAt: null,
      ...excludeOpeningStockPurchasesWhere(),
    },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    select: { lines: true },
    take: 120,
  });

  const byItemId = new Map<string, number>();
  const bySku = new Map<string, number>();

  for (const movement of movements) {
    const lines = Array.isArray(movement.lines) ? movement.lines : [];
    for (const raw of lines) {
      if (!raw || typeof raw !== 'object') continue;
      const line = raw as Record<string, unknown>;
      const unitCost = lineUnitCost(line);
      if (unitCost == null) continue;
      const itemId = typeof line.itemId === 'string' ? line.itemId : '';
      const sku = typeof line.sku === 'string' ? line.sku : '';
      if (itemId && idSet.has(itemId) && !byItemId.has(itemId)) {
        byItemId.set(itemId, unitCost);
      }
      if (sku && skuSet.has(sku) && !bySku.has(sku)) {
        bySku.set(sku, unitCost);
      }
    }
    if (
      [...idSet].every((id) => byItemId.has(id)) ||
      [...skuSet].every((sku) => bySku.has(sku))
    ) {
      break;
    }
  }

  return items.map((item) => {
    if (item.costPrice != null && item.costPrice > 0) return item;
    const latest = byItemId.get(item.id) ?? bySku.get(item.sku);
    if (latest == null) return item;
    return {
      ...item,
      costPrice: latest,
      sellPrice: item.sellPrice != null ? toNumber(item.sellPrice) : latest,
    };
  });
}
