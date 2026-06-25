export const STOCK_STATUSES = [
  "in_stock",
  "low_stock",
  "out_of_stock",
] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];

export interface Item {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  category: string | null;
  quantity: number;
  binLocation: string | null;
  locationCode: string | null;
  reorderPoint: number | null;
  costPrice: number;
  currency: string;
  status: StockStatus;
  availableForRetail: boolean;
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ItemFilters {
  status?: StockStatus;
  category?: string;
  cursor?: string;
  limit?: number;
  search?: string;
}

export interface KpiSummary {
  totalSku: number;
  todayInbound: number;
  todayOutbound: number;
  stockValue: number;
  currency: string;
}
