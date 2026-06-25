export const MOVEMENT_TYPES = ["inbound", "outbound", "transfer"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_STATUSES = [
  "Pending",
  "Approved",
  "Received",
  "Shipped",
  "Delivered",
] as const;

export type MovementStatus = (typeof MOVEMENT_STATUSES)[number];

export interface StockMovementLine {
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
}

export const MOVEMENT_SOURCES = ["standard", "purchase_return"] as const;
export type MovementSource = (typeof MOVEMENT_SOURCES)[number];

export interface StockMovement {
  id: string;
  tenantId: string;
  type: MovementType;
  reference: string;
  status: MovementStatus;
  lines: StockMovementLine[];
  notes: string | null;
  locationCode: string | null;
  supplierId: string | null;
  source: MovementSource | null;
  date: string;
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransferZoneSummary {
  id: string;
  name: string;
  totalSkus: number;
  totalUnits: number;
  pendingTransfers: number;
  utilizationPercent: number;
}

export interface TransferRow extends StockMovement {
  fromZone: string;
  toZone: string;
  requestedBy: string;
  displayStatus: "Pending" | "In Transit" | "Completed" | "Rejected";
  itemsSummary: string;
}
