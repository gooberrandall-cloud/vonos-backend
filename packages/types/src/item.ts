export const STOCK_STATUSES = [
  "in_stock",
  "low_stock",
  "out_of_stock",
] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];

/** Per-location quantity breakdown for an item (branch/counter + qty). */
export interface ItemLocationStock {
  locationCode: string;
  binLocation: string | null;
  quantity: number;
}

/** Input shape when writing per-location stock rows (create/update). */
export interface ItemLocationStockInput {
  locationCode: string;
  binLocation?: string | null;
  quantity: number;
}

export interface Item {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  category: string | null;
  subCategory?: string | null;
  description?: string | null;
  barcodeType?: string | null;
  unit?: string | null;
  weight?: string | null;
  /** Free-text car model fitment for part suggestions. */
  carModel?: string | null;
  enableImei?: boolean;
  preparationMinutes?: number | null;
  quantity: number;
  /**
   * Available for sale/transfer after Approved requisition holds.
   * When omitted, treat as equal to `quantity` (on-hand).
   */
  availableQuantity?: number;
  binLocation: string | null;
  locationCode: string | null;
  reorderPoint: number | null;
  costPrice: number;
  /** Selling price for POS; falls back to costPrice when unset. */
  sellPrice: number | null;
  currency: string;
  status: StockStatus;
  availableForRetail: boolean;
  brandId?: string | null;
  brandName?: string | null;
  /** Per-location breakdown; `quantity` above is the sum across these. */
  locationStock: ItemLocationStock[];
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ItemFilters {
  status?: StockStatus;
  category?: string;
  search?: string;
  locationCode?: string;
  /** Exact unit label match (e.g. "Single (sng)"). */
  unit?: string;
  /** Filter by brand display name (case-insensitive). */
  brandName?: string;
  /** When set, filter items by retail flag (HQ6 "Not for selling" → false). */
  availableForRetail?: boolean;
  cursor?: string;
  limit?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  /** When false, skip count/amountSummary for faster first paint. */
  includeSummary?: boolean;
}

export interface KpiSummary {
  totalSku: number;
  todayInbound: number;
  todayOutbound: number;
  stockValue: number;
  currency: string;
}
