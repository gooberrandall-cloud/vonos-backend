export const BULK_PRICE_ADJUSTMENT_TYPES = ["fixed", "percentage"] as const;

export type BulkPriceAdjustmentType = (typeof BULK_PRICE_ADJUSTMENT_TYPES)[number];

export interface BulkUpdatePriceRequest {
  category?: string;
  itemIds?: string[];
  adjustmentType: BulkPriceAdjustmentType;
  adjustmentValue: number;
}

export interface BulkUpdatePriceResult {
  updated: number;
}
