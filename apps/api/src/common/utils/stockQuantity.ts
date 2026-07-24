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
    grandTotal += quantity * (Number.isNaN(unitCost) ? 0 : unitCost);
  }
  return { itemCount, grandTotal };
}
