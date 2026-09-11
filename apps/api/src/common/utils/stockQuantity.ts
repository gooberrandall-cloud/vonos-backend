import type { StockStatus } from '@vonos/types';
import { toStringField } from './serializers';

export interface MovementLine {
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
  unitCost?: number;
  expDate?: string;
}

export function computeStockStatus(
  quantity: number,
  reorderPoint: number | null,
): StockStatus {
  if (quantity <= 0) return 'out_of_stock';
  if (reorderPoint !== null && quantity <= reorderPoint) return 'low_stock';
  return 'in_stock';
}

const INBOUND_APPLIED = new Set(['Received']);
const OUTBOUND_APPLIED = new Set(['Shipped', 'Delivered']);

export function shouldApplyInboundQty(
  previousStatus: string,
  nextStatus: string,
): boolean {
  return !INBOUND_APPLIED.has(previousStatus) && nextStatus === 'Received';
}

export function shouldApplyOutboundQty(
  previousStatus: string,
  nextStatus: string,
): boolean {
  return (
    !OUTBOUND_APPLIED.has(previousStatus) && OUTBOUND_APPLIED.has(nextStatus)
  );
}

export function parseMovementLines(lines: unknown): MovementLine[] {
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((line) => {
    if (
      typeof line !== 'object' ||
      line === null ||
      !('itemId' in line) ||
      !('quantity' in line)
    ) {
      return [];
    }
    const record = line as Record<string, unknown>;
    const itemId = String(record.itemId);
    const quantity = Number(record.quantity);
    if (!itemId || Number.isNaN(quantity) || quantity <= 0) return [];
    const unitCostRaw = record.unitCost;
    const unitCost =
      unitCostRaw === null || unitCostRaw === undefined
        ? undefined
        : Number(unitCostRaw);
    return [
      {
        itemId,
        sku: toStringField(record.sku),
        name: toStringField(record.name),
        quantity,
        ...(unitCost !== undefined && !Number.isNaN(unitCost)
          ? { unitCost }
          : {}),
        ...(typeof record.expDate === 'string' && record.expDate
          ? { expDate: record.expDate }
          : {}),
      },
    ];
  });
}

/** Persist on write so list queries never expand lines JSON. */
/** Sum quantities per itemId for inbound receipt stock math. */
export function movementLineQtyByItemId(
  lines: MovementLine[],
): Map<string, number> {
  const byItem = new Map<string, number>();
  for (const line of lines) {
    if (!line.itemId) continue;
    byItem.set(
      line.itemId,
      (byItem.get(line.itemId) ?? 0) + line.quantity,
    );
  }
  return byItem;
}

/**
 * Stock delta when an inbound purchase changes status and/or line quantities.
 * When already Received and staying Received, use net qty change only — do not
 * fully reverse the old receipt then re-apply (that fails if stock was sold).
 */
export function inboundReceiptStockDelta(args: {
  wasReceived: boolean;
  willReceive: boolean;
  prevLines: MovementLine[];
  nextLines: MovementLine[];
}): Map<string, number> {
  const prevByItem = args.wasReceived
    ? movementLineQtyByItemId(args.prevLines)
    : new Map<string, number>();
  const nextByItem = args.willReceive
    ? movementLineQtyByItemId(args.nextLines)
    : new Map<string, number>();
  const deltas = new Map<string, number>();
  const itemIds = new Set([...prevByItem.keys(), ...nextByItem.keys()]);

  for (const itemId of itemIds) {
    const prevQty = prevByItem.get(itemId) ?? 0;
    const nextQty = nextByItem.get(itemId) ?? 0;
    let delta: number;
    if (args.wasReceived && args.willReceive) {
      delta = nextQty - prevQty;
    } else if (args.wasReceived) {
      delta = -prevQty;
    } else if (args.willReceive) {
      delta = nextQty;
    } else {
      delta = 0;
    }
    if (delta !== 0) deltas.set(itemId, delta);
  }
  return deltas;
}

export function movementLineRollups(lines: unknown): {
  itemCount: number;
  grandTotal: number;
} {
  if (!Array.isArray(lines)) return { itemCount: 0, grandTotal: 0 };
  let itemCount = 0;
  let grandTotal = 0;
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) continue;
    const record = line as Record<string, unknown>;
    const quantity = Number(record.quantity ?? 0);
    if (Number.isNaN(quantity)) continue;
    itemCount += 1;
    const unitCost = Number(record.unitCost ?? 0);
    const discountPercent = Number(record.discountPercent ?? 0);
    const disc = Number.isFinite(discountPercent)
      ? Math.min(100, Math.max(0, discountPercent))
      : 0;
    const effectiveUnit =
      (Number.isNaN(unitCost) ? 0 : unitCost) * (1 - disc / 100);
    grandTotal += quantity * effectiveUnit;
  }
  return { itemCount, grandTotal };
}
