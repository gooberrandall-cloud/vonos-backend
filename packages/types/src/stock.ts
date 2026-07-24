import type { StockStatus } from "./item";

/** One branch/counter holding of a SKU within a single entity. */
export interface StockAvailabilityLocation {
  locationCode: string;
  binLocation: string | null;
  quantity: number;
}

/** A single entity's holding of a SKU (rolled up across its locations). */
export interface StockAvailabilityEntityRow {
  tenantCode: string;
  tenantName: string;
  itemId: string;
  /** On-hand quantity (physical). */
  quantity: number;
  /** Qty held by Approved, unfulfilled requisitions. */
  reserved: number;
  /** Sellable / transferable: onHand − reserved. */
  available: number;
  reorderPoint: number | null;
  status: StockStatus;
  availableForRetail: boolean;
  locations: StockAvailabilityLocation[];
}

/** A SKU aggregated across every auto-group entity that stocks it. */
export interface StockAvailabilityGroup {
  sku: string;
  name: string;
  category: string | null;
  totalQuantity: number;
  totalAvailable: number;
  entities: StockAvailabilityEntityRow[];
}

export interface StockAvailabilityResult {
  query: string;
  groups: StockAvailabilityGroup[];
}
