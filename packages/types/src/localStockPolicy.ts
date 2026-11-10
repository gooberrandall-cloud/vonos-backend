import {
  isPriceCatalogOnlyTenant,
} from './catalogPresets';
import { isOutsideOrServiceCatalogItem } from './outsideCatalog';

export type LocalStockTenantLike = {
  code?: string | null;
  archetype?: string | null;
};

export type LocalStockItemLike = {
  name?: string | null;
  sku?: string | null;
  category?: string | null;
};

/**
 * Single policy for whether Item.quantity / ItemLocationStock should change.
 *
 * - VA / VP (and job-archetype tenants): price catalog — purchases/sales do not
 *   move local on-hand (warehouse stock lives at VW / VISP / VSP).
 * - OT / labour / service SKUs: billed like products, never stocked.
 * - VW / VISP / VSP / VKW: normal stock tracking.
 */
export function shouldAdjustLocalItemStock(
  tenant: LocalStockTenantLike,
  item?: LocalStockItemLike | null,
): boolean {
  if (isPriceCatalogOnlyTenant(tenant.code, tenant.archetype ?? undefined)) {
    return false;
  }
  if (item && isOutsideOrServiceCatalogItem(item)) {
    return false;
  }
  return true;
}
