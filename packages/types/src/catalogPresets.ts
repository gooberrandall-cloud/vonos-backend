import type { BusinessLocation } from "./tenantConfig";

/** Legacy WordPress `business_locations` — branch / POS sites per entity. */
export const BUSINESS_LOCATION_PRESETS: Record<string, BusinessLocation[]> = {
  VW: [{ code: "BL004", name: "VONOS HEAD OFFICE" }],
  VISP: [{ code: "BL005", name: "Vonos Institute Spare Parts" }],
  VSP: [{ code: "BL001", name: "Vonos SP Marketplace" }],
  VC: [{ code: "BL0001", name: "Vonos Cafe" }],
  VAG: [{ code: "BL003", name: "VONOS GWARIMPA BRANCH" }],
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
  VA: [
    { code: "VS001", name: "Vonos Sales 001" },
    { code: "VS002", name: "Vonos Sales 002" },
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
