/**
 * Shared HQ6 Ultimate POS module set for all operating tenants.
 * Workshop / cafe / salon extras are unioned per-tenant in tenantConfigs.
 */
export const HQ6_POS_ENABLED_MODULES = [
  "customers",
  "suppliers",
  "purchases",
  "movements",
  "sales",
  "returns",
  "inventory",
  "paymentAccounts",
  "pos",
  "quotations",
  "discounts",
  "shipments",
  "bulkImport",
  "bulkPriceUpdate",
  "productVariations",
  "productLabels",
  "legacyRoles",
  "reports",
  "finance",
  "hrm",
] as const;

export type Hq6PosModule = (typeof HQ6_POS_ENABLED_MODULES)[number];

/**
 * Enabled modules for Ultimate POS–style retail catalog tenants (VISP + VSP).
 * Legacy `visp.vonosautomarket.com` and `vsp.vonosautomarket.com` share the same
 * Laravel module tree; Vonos uses one wiring profile with per-tenant labels only.
 * Includes HQ6 POS base (+ movements / legacyRoles for full sidebar parity).
 */
export const RETAIL_CATALOG_ENABLED_MODULES = [
  ...HQ6_POS_ENABLED_MODULES,
] as const;

export type RetailCatalogModule = (typeof RETAIL_CATALOG_ENABLED_MODULES)[number];
