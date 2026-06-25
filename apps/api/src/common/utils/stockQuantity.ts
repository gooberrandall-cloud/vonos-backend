import type { StockStatus } from '@vonos/types';
import { toStringField } from './serializers';

export interface MovementLine {
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
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
    return [
      {
        itemId,
        sku: toStringField(record.sku),
        name: toStringField(record.name),
        quantity,
      },
    ];
  });
}
