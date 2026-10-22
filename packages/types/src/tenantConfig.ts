import { z } from "zod";
import { ARCHETYPES } from "./role";
import { Hq6BusinessSettingsSchema } from "./businessSettings";
import { HrmSettingsSchema } from "./hrmEssentials";

export const NavItemSchema = z.object({
  label: z.string(),
  icon: z.string(),
  route: z.string(),
  pageType: z.enum(["dashboard", "list", "detail", "form"]),
});

export const KpiCardSchema = z.object({
  label: z.string(),
  icon: z.string(),
  metricKey: z.string(),
  color: z.string(),
});

export const BusinessLocationSchema = z.object({
  code: z.string(),
  name: z.string(),
  /** Street / landmark shown on invoices and location lists. */
  landmark: z.string().optional(),
  city: z.string().optional(),
  zipCode: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  mobile: z.string().optional(),
  alternateNumber: z.string().optional(),
  email: z.string().optional(),
});

export const TenantConfigSchema = z.object({
  tenantId: z.string().nullable(),
  code: z.string().optional(),
  name: z.string().optional(),
  archetype: z.enum(ARCHETYPES).nullable(),
  navItems: z.array(NavItemSchema),
  kpiCards: z.array(KpiCardSchema),
  terminology: z.record(z.string()),
  enabledModules: z.array(z.string()),
  /** Shared item/menu categories for inventory + orders. */
  itemCategories: z.array(z.string()).optional(),
  /** Branch / POS sites (legacy `business_locations`). */
  businessLocations: z.array(BusinessLocationSchema).optional(),
  /** Bin / rack slots within a branch. */
  storageLocations: z.array(z.string()).optional(),
  /** HQ6 Business Settings form bag (tabs + custom labels). */
  businessSettings: Hq6BusinessSettingsSchema.optional(),
  /** Essentials / HRM Settings (Leave, Payroll, Attendance, …). */
  hrmSettings: HrmSettingsSchema.optional(),
});

export type NavItem = z.infer<typeof NavItemSchema>;
export type KpiCardConfig = z.infer<typeof KpiCardSchema>;
export type BusinessLocation = z.infer<typeof BusinessLocationSchema>;
export type TenantConfig = z.infer<typeof TenantConfigSchema>;

export function parseTenantConfig(data: unknown): TenantConfig {
  return TenantConfigSchema.parse(data);
}

/** Partial tenant config patch for settings save. */
export type UpdateTenantConfigRequest = Partial<
  Pick<
    TenantConfig,
    | "name"
    | "terminology"
    | "enabledModules"
    | "itemCategories"
    | "businessLocations"
    | "storageLocations"
    | "businessSettings"
    | "hrmSettings"
  >
> & {
  accentColor?: string;
};
