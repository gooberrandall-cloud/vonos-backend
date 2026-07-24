export const MOVEMENT_TYPES = ["inbound", "outbound", "transfer"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_STATUSES = [
  "Ordered",
  "Pending",
  "Approved",
  "Received",
  "Shipped",
  "Delivered",
] as const;

export type MovementStatus = (typeof MOVEMENT_STATUSES)[number];

/** Purchase lifecycle statuses used in the Purchases list UI. */
export const PURCHASE_STATUSES = ["Ordered", "Pending", "Delivered"] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const PURCHASE_PAYMENT_STATUSES = [
  "paid",
  "due",
  "partial",
  "overdue",
] as const;
export type PurchasePaymentStatus = (typeof PURCHASE_PAYMENT_STATUSES)[number];

export interface StockMovementLine {
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
  unitCost?: number;
  /** HQ6 purchase-line expiry — stored on inbound movement JSON lines. */
  expDate?: string;
}

export interface StockMovementListRow {
  id: string;
  reference: string;
  supplierOrDest: string;
  itemCount: number;
  status: MovementStatus;
  date: string;
  locationCode?: string | null;
  locationName?: string | null;
  grandTotal?: number;
  paymentStatus?: string | null;
  paymentMethod?: string | null;
  paymentDue?: number;
  supplierId?: string | null;
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
  paymentStatus: PurchasePaymentStatus | null;
  paymentMethod: string | null;
  date: string;
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StockMovementFilters {
  type?: MovementType;
  status?: MovementStatus;
  source?: MovementSource;
  locationCode?: string;
  supplierId?: string;
  paymentStatus?: PurchasePaymentStatus;
  paymentMethod?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
  search?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  /** When false, skip count for faster first paint. */
  includeSummary?: boolean;
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

export interface PurchasePaymentViewRow {
  id: string;
  amount: number;
  currency: string;
  method: string | null;
  paymentRefNo: string | null;
  paidOn: string | null;
  note: string | null;
  accountId: string | null;
  accountName: string | null;
  createdByName: string | null;
}

/** Purchase modal: movement + payments + supplier in one round-trip. */
export interface PurchaseViewBundle {
  movement: StockMovement;
  payments: PurchasePaymentViewRow[];
  supplier: import("./supplier").SupplierListRow | null;
}
