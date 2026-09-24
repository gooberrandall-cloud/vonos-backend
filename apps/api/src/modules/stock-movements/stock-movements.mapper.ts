import type { StockMovement as PrismaMovement } from '@prisma/client';
import type {
  MovementStatus,
  StockMovement,
  StockMovementLine,
  StockMovementListRow,
} from '@vonos/types';
import { paymentStatusFromAmounts } from '../../common/utils/paymentStatus';
import { parseMovementLines, toIso, toNumber } from '../../common/utils/serializers';
import { movementLineRollups } from '../../common/utils/stockQuantity';

export type { StockMovementListRow };

export function serializeMovement(row: PrismaMovement): StockMovement {
  const lines = parseMovementLines(row.lines) as StockMovementLine[];
  const rollups = movementLineRollups(row.lines ?? []);
  const totalPaid =
    row.totalPaid != null ? toNumber(row.totalPaid) : 0;
  const paymentDue = Math.max(0, rollups.grandTotal - totalPaid);
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    reference: row.reference,
    status: row.status,
    lines,
    notes: row.notes,
    locationCode: row.locationCode,
    supplierId: row.supplierId,
    source: row.source,
    paymentStatus: row.paymentStatus ?? null,
    paymentMethod: row.paymentMethod ?? null,
    totalPaid,
    paymentDue,
    date: toIso(row.date),
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toMovementListRow(
  row: Omit<PrismaMovement, 'lines' | 'itemCount' | 'grandTotal'> & {
    lines?: PrismaMovement['lines'] | null;
    supplier?: { name: string } | null;
    /** Precomputed — avoids shipping full lines JSON on list. */
    itemCount?: number | null;
    grandTotal?: number | PrismaMovement['grandTotal'] | null;
    totalPaid?: number | PrismaMovement['totalPaid'] | null;
  },
  /** Optional override (tests / legacy). Prefer row.totalPaid. */
  paidTotal?: number,
): StockMovementListRow {
  const supplierOrDest =
    row.supplier?.name ??
    (row.notes?.split('|')[0]?.trim() || row.notes || '—');
  let itemCount = row.itemCount ?? undefined;
  let grandTotal =
    row.grandTotal == null ? undefined : toNumber(row.grandTotal);
  if (itemCount == null || grandTotal == null) {
    const rollups = movementLineRollups(row.lines ?? []);
    itemCount = itemCount ?? rollups.itemCount;
    grandTotal = grandTotal ?? rollups.grandTotal;
  }
  const denormPaid =
    row.totalPaid != null ? toNumber(row.totalPaid) : 0;
  const safePaid = Math.max(0, paidTotal ?? denormPaid);
  const total = grandTotal ?? 0;
  const paymentDue = Math.max(0, total - safePaid);
  const paymentStatus = paymentStatusFromAmounts(
    total,
    safePaid,
    row.paymentStatus,
  );
  return {
    id: row.id,
    reference: row.reference,
    supplierOrDest,
    itemCount,
    status: row.status,
    date: toIso(row.date).slice(0, 10),
    locationCode: row.locationCode,
    locationName: row.locationCode ?? '—',
    grandTotal,
    totalPaid: safePaid,
    paymentStatus,
    paymentMethod: row.paymentMethod ?? null,
    paymentDue,
    supplierId: row.supplierId,
    createdByName: row.createdByName,
    notes: row.notes ?? null,
  };
}

export interface TransferRow extends StockMovement {
  fromZone: string;
  toZone: string;
  requestedBy: string;
  displayStatus: 'Pending' | 'In Transit' | 'Completed' | 'Rejected';
  itemsSummary: string;
}

export function toTransferRow(row: PrismaMovement): TransferRow {
  const base = serializeMovement(row);
  const lines = parseMovementLines(row.lines);
  const parts = (row.notes ?? '').split('|').map((p) => p.trim());
  const fromZone = parts[0] || 'Zone A';
  const toZone = parts[1] || 'Zone B';
  const requestedBy = parts[2] || 'System';
  const displayStatus = mapTransferDisplayStatus(row.status);
  const itemsSummary =
    lines.length > 0
      ? `${lines[0]?.name ?? 'Item'}${lines.length > 1 ? ` +${lines.length - 1}` : ''}`
      : '—';

  return {
    ...base,
    fromZone,
    toZone,
    requestedBy,
    displayStatus,
    itemsSummary,
  };
}

function mapTransferDisplayStatus(
  status: string,
): TransferRow['displayStatus'] {
  switch (status) {
    case 'Pending':
      return 'Pending';
    case 'Approved':
    case 'Shipped':
      return 'In Transit';
    case 'Delivered':
    case 'Received':
      return 'Completed';
    default:
      return 'Rejected';
  }
}

export interface TransferZoneSummary {
  id: string;
  name: string;
  totalSkus: number;
  totalUnits: number;
  pendingTransfers: number;
  utilizationPercent: number;
}
