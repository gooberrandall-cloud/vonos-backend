import type { MovementLine } from './stockQuantity';

export type PurchaseLineLike = {
  itemId: string;
  sku?: string;
  name?: string;
  quantity: number;
  unitCost?: number;
  discountPercent?: number;
  unitSellingPrice?: number;
  expDate?: string;
};

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Stable compare for purchase lines — stock + cost fields that affect totals. */
export function purchaseLinesEqual(
  a: PurchaseLineLike[],
  b: PurchaseLineLike[],
): boolean {
  if (a.length !== b.length) return false;
  const sortKey = (line: PurchaseLineLike) =>
    `${line.itemId}|${line.sku ?? ''}|${line.quantity}|${num(line.unitCost)}|${num(line.discountPercent)}|${line.expDate ?? ''}`;
  const left = [...a].map(sortKey).sort();
  const right = [...b].map(sortKey).sort();
  return left.every((key, i) => key === right[i]);
}

export function sellPriceChanges(
  baseline: PurchaseLineLike[],
  next: PurchaseLineLike[],
): Array<{ itemId: string; sellPrice: number }> {
  const prevById = new Map(
    baseline.map((line) => [line.itemId, num(line.unitSellingPrice)]),
  );
  const out: Array<{ itemId: string; sellPrice: number }> = [];
  for (const line of next) {
    if (!line.itemId) continue;
    const nextPrice = roundMoney(num(line.unitSellingPrice));
    const prevPrice = roundMoney(prevById.get(line.itemId) ?? NaN);
    if (!Number.isFinite(prevPrice) || Math.abs(nextPrice - prevPrice) > 0.009) {
      out.push({ itemId: line.itemId, sellPrice: nextPrice });
    }
  }
  return out;
}

export type PurchaseHeaderSnapshot = {
  reference: string;
  status: string;
  supplierId: string | null;
  locationCode: string | null;
  dateIso: string;
  notes: string | null;
  paymentMethod: string | null;
  paymentStatus: string | null;
};

export function purchaseHeaderChanged(
  prev: PurchaseHeaderSnapshot,
  next: PurchaseHeaderSnapshot,
): boolean {
  return (
    prev.reference !== next.reference ||
    prev.status !== next.status ||
    (prev.supplierId ?? null) !== (next.supplierId ?? null) ||
    (prev.locationCode ?? null) !== (next.locationCode ?? null) ||
    prev.dateIso !== next.dateIso ||
    (prev.notes ?? null) !== (next.notes ?? null) ||
    (prev.paymentMethod ?? null) !== (next.paymentMethod ?? null) ||
    (prev.paymentStatus ?? null) !== (next.paymentStatus ?? null)
  );
}

export function toMovementLines(lines: PurchaseLineLike[]): MovementLine[] {
  return lines.map((line) => ({
    itemId: line.itemId,
    sku: line.sku ?? '',
    name: line.name ?? '',
    quantity: num(line.quantity),
    ...(line.unitCost !== undefined ? { unitCost: num(line.unitCost) } : {}),
    ...(line.expDate ? { expDate: line.expDate } : {}),
  }));
}
