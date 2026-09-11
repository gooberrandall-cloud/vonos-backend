import type { BusinessLocation } from "./tenantConfig";

/**
 * Stock-holding business locations (cross-entity moves / group stock views).
 * Each of VA / VP / VW / VISP / VSP keeps products in its own tenant catalog;
 * these codes are still used when stock is moved between stock homes.
 */
export const PRODUCT_STOCK_LOCATION_CODES = ["VW", "VISP", "VSP"] as const;

export type ProductStockLocationCode =
  (typeof PRODUCT_STOCK_LOCATION_CODES)[number];

/**
 * Job/service tenants with a local product price catalog (no stock).
 * Parts stock lives at VW / VISP / VSP; VA / VP bill from their own catalog.
 */
export const GROUP_STOCK_CONSUMER_CODES = ["VA", "VP"] as const;

export type GroupStockConsumerCode =
  (typeof GROUP_STOCK_CONSUMER_CODES)[number];

/** Tenants that own a product catalog scoped to that entity only. */
export const PRODUCT_OWN_SCOPE_CODES = [
  "VA",
  "VP",
  "VW",
  "VISP",
  "VSP",
] as const;

export type ProductOwnScopeCode = (typeof PRODUCT_OWN_SCOPE_CODES)[number];

export const PRODUCT_STOCK_BUSINESS_LOCATIONS: BusinessLocation[] = [
  { code: "VW", name: "Vonos Warehouse" },
  { code: "VISP", name: "Vonos Institute Spare Parts" },
  { code: "VSP", name: "Vonos SP Marketplace" },
];

const PRODUCT_HOME_BY_CODE: Record<ProductOwnScopeCode, BusinessLocation> = {
  VA: { code: "VA", name: "Vonos Mechanic" },
  VP: { code: "VP", name: "Vonos Painting" },
  VW: { code: "VW", name: "Vonos Warehouse" },
  VISP: { code: "VISP", name: "Vonos Institute Spare Parts" },
  VSP: { code: "VSP", name: "Vonos SP Marketplace" },
};

export function isProductStockLocationCode(
  code: string | null | undefined,
): code is ProductStockLocationCode {
  if (!code?.trim()) return false;
  const upper = code.trim().toUpperCase();
  return (PRODUCT_STOCK_LOCATION_CODES as readonly string[]).includes(upper);
}

export function isProductStockTenant(code: string | null | undefined): boolean {
  return isProductStockLocationCode(code);
}

export function isProductOwnScopeTenant(
  code: string | null | undefined,
): code is ProductOwnScopeCode {
  if (!code?.trim()) return false;
  const upper = code.trim().toUpperCase();
  return (PRODUCT_OWN_SCOPE_CODES as readonly string[]).includes(upper);
}

/**
 * Product form / list location for this tenant — own home only
 * (VA→VA, VISP→VISP, …). Cross-entity moves still use PRODUCT_STOCK_*.
 */
export function productHomeLocationsForTenant(
  code: string | null | undefined,
): BusinessLocation[] {
  if (!isProductOwnScopeTenant(code)) return [];
  return [PRODUCT_HOME_BY_CODE[code.trim().toUpperCase() as ProductOwnScopeCode]];
}

/** VA / VP — source parts from VW/VISP/VSP or purchases, not a local stock warehouse. */
export function isGroupStockConsumerTenant(
  code: string | null | undefined,
): boolean {
  if (!code?.trim()) return false;
  const upper = code.trim().toUpperCase();
  return (GROUP_STOCK_CONSUMER_CODES as readonly string[]).includes(upper);
}

/**
 * Price-list tenants (VA / VP): hide qty / stock value and never validate
 * or deduct local catalog quantity on sales.
 */
export function isPriceCatalogOnlyTenant(
  code: string | null | undefined,
  archetype?: string | null,
): boolean {
  if (isGroupStockConsumerTenant(code)) return true;
  return archetype === "job";
}

/** Legacy WordPress `business_locations` — branch / POS sites per entity. */
export const BUSINESS_LOCATION_PRESETS: Record<string, BusinessLocation[]> = {
  /** Own-scope product + sale locations (not shared VW∪VISP∪VSP). */
  VW: [PRODUCT_HOME_BY_CODE.VW],
  VISP: [PRODUCT_HOME_BY_CODE.VISP],
  VSP: [PRODUCT_HOME_BY_CODE.VSP],
  VC: [{ code: "BL0001", name: "Vonos Cafe" }],
  VM: [
    { code: "BL0001", name: "VONOS AUTOS WAREHOUSE" },
    { code: "BL0002", name: "Mainshop" },
    { code: "BL0004", name: "OTHER SUPPLIERS" },
    { code: "BL004", name: "VONOS HEAD OFFICE" },
  ],
  VMS: [
    { code: "BL0002", name: "Mainshop" },
    { code: "BL005", name: "VONOS PAINTING MATERIALS" },
    { code: "BL006", name: "PAINTING WORKS" },
    { code: "BL0008", name: "LABOUR/CONSUMABLES" },
  ],
  VS: [{ code: "BL0003", name: "Vonos saloon" }],
  /** Kids Wear — single retail shop (no multi-branch stock yet). */
  VKW: [{ code: "VKW", name: "Vonos Kids Wear" }],
  /** Mechanic own branch only — sister entities are not sale/expense locations. */
  VA: [PRODUCT_HOME_BY_CODE.VA],
  /** Painting own branch only. */
  VP: [PRODUCT_HOME_BY_CODE.VP],
  /** Group / payroll primary locations — VISP + All. */
  VAG: [
    { code: "ALL", name: "All Locations" },
    { code: "VISP", name: "Vonos Institute Spare Parts" },
    { code: "VA", name: "Vonos Mechanic" },
    { code: "VP", name: "Vonos Painting" },
    { code: "VW", name: "Vonos Warehouse" },
    { code: "VSP", name: "Vonos SP Marketplace" },
  ],
};

export const ITEM_CATEGORY_PRESETS: Record<string, string[]> = {
  VW: ["Packaging", "Brakes", "Lubricants", "Filters", "Suspension", "Storage", "Supplies"],
  VKW: ["Tops", "Bottoms", "Accessories", "Seasonal"],
  VISP: ["Brakes", "Filters", "Electrical", "Lubricants", "Suspension", "Performance"],
  VSP: ["Brakes", "Filters", "Electrical", "Body Parts", "Accessories"],
  VC: ["Hot Drinks", "Cold Drinks", "Pastries", "Snacks"],
  VM: ["Labour", "Parts", "Consumables", "Subcontract"],
  VMS: ["Labour", "Parts", "Consumables", "Subcontract", "Fabrication"],
  VS: ["Hair", "Nails", "Spa", "Retail"],
};

/** Warehouse bin / rack codes (separate from branch locations). */
export const STORAGE_LOCATION_PRESETS: Record<string, string[]> = {
  VW: ["R1-S1-B3", "R2-S3-B4", "R2-S4-B1", "R2-S4-B2", "R2-S5-B1", "R3-S2-B1", "A-12-03", "B-04-01", "C-02-07", "D-08-02"],
  VKW: ["A-01", "A-02", "B-01", "B-02"],
};

export function catalogPresetsForCode(code: string | undefined) {
  const key = code ?? "VW";
  return {
    itemCategories: ITEM_CATEGORY_PRESETS[key] ?? [],
    businessLocations: BUSINESS_LOCATION_PRESETS[key] ?? [],
    storageLocations: STORAGE_LOCATION_PRESETS[key] ?? [],
  };
}
