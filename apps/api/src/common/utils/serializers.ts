import type { Prisma } from '@prisma/client';
import { SaleStatus } from '@prisma/client';
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
  written_off: 'Written Off',
  draft: 'Completed',
  quotation: 'Completed',
};

/** Human label for list badges when recordStatus differs from return vocabulary. */
export function mapSaleRecordStatusLabel(status: string): string {
  if (status === 'draft') return 'Draft';
  if (status === 'quotation') return 'Quotation';
  return mapSaleStatusToUi(status);
}

export function mapSaleStatusToUi(status: string): SaleReturnStatus {
  return SALE_STATUS_TO_UI[status] ?? 'Completed';
}

const RETURN_PRISMA_STATUSES: SaleStatus[] = [
  SaleStatus.refunded,
  SaleStatus.partially_refunded,
  SaleStatus.written_off,
];

export function prismaSaleStatusesForUi(
  uiStatus: SaleReturnStatus,
): SaleStatus[] {
  return Object.entries(SALE_STATUS_TO_UI)
    .filter(([, ui]) => ui === uiStatus)
    .map(([db]) => db as SaleStatus);
}

export function saleStatusWhereClause(filters: {
  status?: SaleReturnStatus;
  saleStatus?: string;
  returnsOnly?: boolean;
  shipmentsOnly?: boolean;
}): Pick<Prisma.SaleWhereInput, 'status' | 'shippingStatus'> {
  if (filters.shipmentsOnly) {
    return { shippingStatus: { not: null } };
  }
  if (filters.returnsOnly) {
    return { status: { in: RETURN_PRISMA_STATUSES } };
  }
  if (filters.saleStatus) {
    return { status: filters.saleStatus as SaleStatus };
  }
  if (filters.status) {
    return { status: { in: prismaSaleStatusesForUi(filters.status) } };
  }
  return {};
}

export function parseMovementLines(lines: unknown): Array<{
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
  unitCost?: number;
  expDate?: string;
}> {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => {
    const row = line as Record<string, unknown>;
    const unitCostRaw = row.unitCost;
    const unitCost =
      unitCostRaw === null || unitCostRaw === undefined
        ? undefined
        : toNumber(unitCostRaw as Prisma.Decimal | number | string | null);
    const expDate =
      typeof row.expDate === 'string' && row.expDate ? row.expDate : undefined;
    return {
      itemId: toStringField(row.itemId),
      sku: toStringField(row.sku),
      name: toStringField(row.name),
      quantity: toNumber(
        row.quantity as Prisma.Decimal | number | string | null,
      ),
      ...(unitCost !== undefined ? { unitCost } : {}),
      ...(expDate ? { expDate } : {}),
    };
  });
}
