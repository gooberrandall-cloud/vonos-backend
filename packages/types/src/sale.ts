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
  "draft",
] as const;

export type SaleStatus = (typeof SALE_STATUSES)[number];

export const PAYMENT_STATUSES = ["paid", "partial", "due"] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

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
export interface Sale {
  id: string;
  tenantId: string;
  reference: string;
  customerId: string | null;
  customerName: string;
  total: number;
  currency: string;
  status: SaleReturnStatus;
  paymentStatus: PaymentStatus | null;
  locationCode: string | null;
  itemCount: number;
  date: string;
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Detail view includes line items */
export interface SaleDetail extends Sale {
  lines: SaleLine[];
}

export interface SaleFilters {
  status?: SaleReturnStatus;
  customerId?: string;
  cursor?: string;
  limit?: number;
  search?: string;
}

export interface CreateSaleLineRequest {
  itemId?: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
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
  locationCode?: string;
  lines: CreateSaleLineRequest[];
  currency?: string;
  date?: string;
  /** When omitted, a single payment for the sale total is recorded as cash. */
  payments?: CreateSalePaymentRequest[];
}
