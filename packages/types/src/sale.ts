import type { AuditLogEntry } from "./audit";

/** UI-facing labels — matches StatusPill `saleReturnStatus` vocabulary */
export const SALE_RETURN_STATUSES = [
  "Completed",
  "Refunded",
  "Restocked",
  "Written Off",
] as const;

export type SaleReturnStatus = (typeof SALE_RETURN_STATUSES)[number];

/** Stored on Sale records (Prisma / API) */
export const SALE_STATUSES = [
  "completed",
  "refunded",
  "partially_refunded",
  "written_off",
  "draft",
  "quotation",
] as const;

export type SaleStatus = (typeof SALE_STATUSES)[number];

export const PAYMENT_STATUSES = ["paid", "partial", "due", "overdue"] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = [
  "cash",
  "card",
  "transfer",
  "cheque",
  "other",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface SaleLine {
  id: string;
  saleId: string;
  itemId: string | null;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  discountAmount: number | null;
}

/** List / summary shape */
export const SHIPPING_STATUSES = [
  "pending",
  "packed",
  "shipped",
  "delivered",
  "cancelled",
] as const;

export type ShippingStatus = (typeof SHIPPING_STATUSES)[number];

export interface Sale {
  id: string;
  tenantId: string;
  reference: string;
  customerId: string | null;
  customerName: string;
  /** Present when this sale is the commercial record for a job (VA). */
  jobId?: string | null;
  jobReference?: string | null;
  total: number;
  currency: string;
  status: SaleReturnStatus;
  /** Stored DB status (draft, quotation, completed, …) for documents and filters. */
  recordStatus?: SaleStatus;
  paymentStatus: PaymentStatus | null;
  paymentMethod?: string | null;
  locationCode: string | null;
  cleanerUserId?: string | null;
  cleanerName?: string | null;
  serviceStaffEmployeeId?: string | null;
  serviceStaffEmployeeName?: string | null;
  shippingStatus?: ShippingStatus | null;
  shippingAddress?: string | null;
  trackingNumber?: string | null;
  itemCount: number;
  date: string;
  discountAmount: number | null;
  taxAmount: number | null;
  notes: string | null;
  originalSaleId?: string | null;
  originalSaleReference?: string | null;
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Populated on list rows when customer is joined. */
  customerPhone?: string | null;
  /** Sum of non-return payments on the sale (list/detail). */
  totalPaid?: number;
  /** Remaining balance: total − totalPaid (≥ 0). */
  sellDue?: number;
}

/** Detail view includes line items */
export interface SaleDetail extends Sale {
  lines: SaleLine[];
  /** Contact fields from linked customer — enough for invoice preview without a second fetch. */
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerBusinessName?: string | null;
  customerTotalSellDue?: number | null;
  /** Linked job vehicle label (make-model plate) when available. */
  vehicleLabel?: string | null;
}

/** One modal round-trip: sale detail + payments + recent activity. */
export interface SalePaymentViewRow {
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

export interface SaleViewBundle {
  sale: SaleDetail;
  payments: SalePaymentViewRow[];
  activities: AuditLogEntry[];
}

export interface SaleFilters {
  status?: SaleReturnStatus;
  /** Filter by stored sale status (draft, quotation, completed, etc.). */
  saleStatus?: SaleStatus;
  /** When true, only sales mapped to return statuses (Refunded / Restocked). */
  returnsOnly?: boolean;
  /** When true, only sales with a shipping status set. */
  shipmentsOnly?: boolean;
  /** Filter by business / branch location code. */
  locationCode?: string;
  customerId?: string;
  /** When set, only the sale linked to this job (VA). */
  jobId?: string;
  paymentStatus?: PaymentStatus;
  paymentMethod?: string;
  shippingStatus?: ShippingStatus;
  cleanerUserId?: string;
  serviceStaffEmployeeId?: string;
  createdByUserId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
  search?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  /** When false, skip count/amountSummary for faster first paint. */
  includeSummary?: boolean;
}

export interface CreateSaleLineRequest {
  itemId?: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  /**
   * When true (or when itemId is omitted), create an inbound purchase for this
   * line so Purchases stays in sync with ad-hoc / missing parts.
   */
  createPurchase?: boolean;
  /** Autos-group source when the part was picked from another entity (e.g. VW). */
  sourceTenantCode?: string;
}

export interface CreateSalePaymentRequest {
  amount: number;
  method?: string;
  note?: string;
  accountId?: string;
}

export interface CreateSaleRequest {
  reference: string;
  customerName?: string;
  customerId?: string;
  /** Required for job-centric tenants (VA) — sale is the job's commercial record. */
  jobId?: string;
  locationCode?: string;
  paymentMethod?: string;
  cleanerUserId?: string;
  cleanerName?: string;
  serviceStaffEmployeeId?: string;
  lines: CreateSaleLineRequest[];
  currency?: string;
  date?: string;
  /** DB status. Use `final` as alias for `completed`. Draft/quotation skip stock and ledger. */
  status?: SaleStatus | "final";
  shippingStatus?: ShippingStatus;
  shippingAddress?: string;
  trackingNumber?: string;
  /** When omitted, a single payment for the sale total is recorded as cash. */
  payments?: CreateSalePaymentRequest[];
  discountAmount?: number;
  taxAmount?: number;
  notes?: string;
}

export interface UpdateSaleShippingRequest {
  shippingStatus?: ShippingStatus | null;
  shippingAddress?: string | null;
  trackingNumber?: string | null;
}

export const SALE_RETURN_DISPOSITIONS = [
  "refunded",
  "restocked",
  "written_off",
] as const;

export type SaleReturnDisposition = (typeof SALE_RETURN_DISPOSITIONS)[number];

export interface CreateSaleReturnLineRequest {
  saleLineId: string;
  quantity: number;
}

export interface CreateSaleReturnRequest {
  disposition: SaleReturnDisposition;
  notes?: string;
  /** Omit to return all lines at full quantity. */
  lines?: CreateSaleReturnLineRequest[];
}
