import type { Brand as PrismaBrand, StockStatus } from '@prisma/client';
import type { Item, KpiSummary } from '@vonos/types';
import { isOutsideOrServiceCatalogItem } from '@vonos/types';
import { toIso, toNumber } from '../../common/utils/serializers';

/** List/detail row shape — supports Prisma `select` projections (not full models). */
export type ItemWithStock = {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  category: string | null;
  subCategory?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  barcodeType?: string | null;
  unit?: string | null;
  weight?: string | null;
  carModel?: string | null;
  enableImei?: boolean | null;
  preparationMinutes?: number | null;
  quantity: number;
  binLocation: string | null;
  locationCode: string | null;
  reorderPoint: number | null;
  costPrice: { toString(): string } | number;
  sellPrice: { toString(): string } | number | null;
  currency: string;
  status: StockStatus;
  availableForRetail: boolean;
  brandId?: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  locationStock?: Array<{
    locationCode: string;
    binLocation: string | null;
    quantity: number;
  }>;
  brand?: Pick<PrismaBrand, 'name'> | null;
};

export function serializeItem(row: ItemWithStock): Item {
  const locationStock = (row.locationStock ?? []).map((entry) => ({
    locationCode: entry.locationCode,
    binLocation: entry.binLocation === '' ? null : entry.binLocation,
    quantity: entry.quantity,
  }));
  const locSum = locationStock.reduce((sum, entry) => sum + entry.quantity, 0);
  // Prefer location bins when header qty is stale (common after opening-stock
  // / location edits) so pickers don't show "0 left" while bins have stock.
  const quantity = Math.max(row.quantity, locSum);

  return {
    id: row.id,
    tenantId: row.tenantId,
    sku: row.sku,
    name: row.name,
    category: row.category,
    subCategory: row.subCategory ?? null,
    description: row.description ?? null,
    imageUrl: row.imageUrl ?? null,
    barcodeType: row.barcodeType ?? null,
    unit: row.unit ?? null,
    weight: row.weight ?? null,
    carModel: row.carModel ?? null,
    enableImei: row.enableImei ?? false,
    preparationMinutes: row.preparationMinutes ?? null,
    quantity,
    availableQuantity: quantity,
    binLocation: row.binLocation,
    locationCode: row.locationCode,
    reorderPoint: row.reorderPoint,
    costPrice: toNumber(row.costPrice),
    sellPrice: row.sellPrice != null ? toNumber(row.sellPrice) : null,
    currency: row.currency,
    status: row.status,
    availableForRetail: row.availableForRetail,
    isOutsideOrService: isOutsideOrServiceCatalogItem({
      name: row.name,
      sku: row.sku,
      category: row.category,
    }),
    brandId: row.brandId ?? null,
    brandName: row.brand?.name ?? null,
    locationStock,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function emptyKpiSummary(currency = 'NGN'): KpiSummary {
  return {
    totalSku: 0,
    todayInbound: 0,
    todayOutbound: 0,
    stockValue: 0,
    currency,
  };
}
