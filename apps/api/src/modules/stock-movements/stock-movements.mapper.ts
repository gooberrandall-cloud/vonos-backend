import type { StockMovement as PrismaMovement } from '@prisma/client';
import type {
  MovementStatus,
  StockMovement,
  StockMovementLine,
} from '@vonos/types';
import { parseMovementLines, toIso } from '../../common/utils/serializers';

export interface StockMovementListRow {
  id: string;
  reference: string;
  supplierOrDest: string;
  itemCount: number;
  status: MovementStatus;
  date: string;
}

export function serializeMovement(row: PrismaMovement): StockMovement {
  const lines = parseMovementLines(row.lines) as StockMovementLine[];
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
    date: toIso(row.date),
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toMovementListRow(
  row: PrismaMovement & { supplier?: { name: string } | null },
): StockMovementListRow {
  const lines = parseMovementLines(row.lines);
  const supplierOrDest =
    row.supplier?.name ??
    (row.notes?.split('|')[0]?.trim() || row.notes || '—');
  return {
    id: row.id,
    reference: row.reference,
    supplierOrDest,
    itemCount: lines.length,
    status: row.status,
    date: toIso(row.date).slice(0, 10),
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
