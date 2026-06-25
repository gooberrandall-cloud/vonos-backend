import type { Prisma } from '@prisma/client';
import type { SaleReturnStatus } from '@vonos/types';

export function toNumber(
  value:
    | Prisma.Decimal
    | number
    | string
    | { toString(): string }
    | null
    | undefined,
): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  return Number(value);
}

export function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : value;
}

export function toStringField(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

const SALE_STATUS_TO_UI: Record<string, SaleReturnStatus> = {
  completed: 'Completed',
  refunded: 'Refunded',
  partially_refunded: 'Restocked',
  draft: 'Completed',
};

export function mapSaleStatusToUi(status: string): SaleReturnStatus {
  return SALE_STATUS_TO_UI[status] ?? 'Completed';
}

export function parseMovementLines(lines: unknown): Array<{
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
}> {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => {
    const row = line as Record<string, unknown>;
    return {
      itemId: toStringField(row.itemId),
      sku: toStringField(row.sku),
      name: toStringField(row.name),
      quantity: toNumber(
        row.quantity as Prisma.Decimal | number | string | null,
      ),
    };
  });
}
