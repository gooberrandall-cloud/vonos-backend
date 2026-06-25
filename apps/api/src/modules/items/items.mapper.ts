import type { Item as PrismaItem } from '@prisma/client';
import type { Item, KpiSummary } from '@vonos/types';
import { toIso, toNumber } from '../../common/utils/serializers';

export function serializeItem(row: PrismaItem): Item {
  return {
    id: row.id,
    tenantId: row.tenantId,
    sku: row.sku,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    binLocation: row.binLocation,
    locationCode: row.locationCode,
    reorderPoint: row.reorderPoint,
    costPrice: toNumber(row.costPrice),
    currency: row.currency,
    status: row.status,
    availableForRetail: row.availableForRetail,
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
