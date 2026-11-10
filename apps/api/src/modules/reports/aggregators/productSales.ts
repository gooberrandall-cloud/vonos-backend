import type { Prisma } from '@prisma/client';
import { toNumber } from '../../../common/utils/serializers';

export interface SaleLineRow {
  name: string;
  sku: string;
  quantity: Prisma.Decimal | number | string | null;
  lineTotal: Prisma.Decimal | number | string | null;
  itemId?: string | null;
}

export interface AggregatedProductSale {
  label: string;
  sku: string;
  units: number;
  revenue: number;
  itemId: string | null;
}

export function aggregateTopProducts(
  sales: Array<{ lines: SaleLineRow[] }>,
  limit = 8,
): AggregatedProductSale[] {
  const byKey = new Map<string, AggregatedProductSale>();

  for (const sale of sales) {
    for (const line of sale.lines) {
      const sku = line.sku?.trim() || line.name;
      const key = sku.toLowerCase();
      const existing = byKey.get(key) ?? {
        label: line.name,
        sku,
        units: 0,
        revenue: 0,
        itemId: line.itemId ?? null,
      };
      existing.units += toNumber(line.quantity);
      existing.revenue += toNumber(line.lineTotal);
      if (!existing.itemId && line.itemId) {
        existing.itemId = line.itemId;
      }
      byKey.set(key, existing);
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => b.units - a.units || b.revenue - a.revenue)
    .slice(0, limit);
}
