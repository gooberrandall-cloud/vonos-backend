import { z } from "zod";

/** Flexible string/boolean bag for one HQ6 Business Settings tab. */
const TabBagSchema = z.record(z.union([z.string(), z.boolean(), z.number()]));

const CustomLabelFieldSchema = z.object({
  label: z.string(),
  required: z.boolean().optional(),
  fieldType: z.string().optional(),
});

export const Hq6BusinessSettingsSchema = z
  .object({
    business: TabBagSchema.optional(),
    tax: TabBagSchema.optional(),
    product: TabBagSchema.optional(),
    contact: TabBagSchema.optional(),
    sale: TabBagSchema.optional(),
    pos: TabBagSchema.optional(),
    displayScreen: TabBagSchema.optional(),
    purchases: TabBagSchema.optional(),
    payment: TabBagSchema.optional(),
    dashboard: TabBagSchema.optional(),
    system: TabBagSchema.optional(),
    prefixes: TabBagSchema.optional(),
    email: TabBagSchema.optional(),
    sms: TabBagSchema.optional(),
    rewardPoints: TabBagSchema.optional(),
    modules: z.record(z.boolean()).optional(),
    customLabels: z
      .object({
        payments: z.array(z.string()).optional(),
        contact: z.array(z.string()).optional(),
        product: z.array(z.string()).optional(),
        location: z.array(z.string()).optional(),
        user: z.array(z.string()).optional(),
        purchase: z.array(z.string()).optional(),
        purchaseShipping: z.array(z.string()).optional(),
        sell: z.array(CustomLabelFieldSchema).optional(),
        saleShipping: z.array(z.string()).optional(),
        typesOfService: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough();

export type Hq6BusinessSettings = z.infer<typeof Hq6BusinessSettingsSchema>;
export type Hq6CustomLabelField = z.infer<typeof CustomLabelFieldSchema>;

export function parseHq6BusinessSettings(data: unknown): Hq6BusinessSettings {
  return Hq6BusinessSettingsSchema.parse(data ?? {});
}

export function mergeHq6BusinessSettings(
  current: Hq6BusinessSettings | undefined,
  patch: Hq6BusinessSettings | undefined,
): Hq6BusinessSettings {
  if (!patch) return current ?? {};
  if (!current) return patch;
  return {
    ...current,
    ...patch,
    business: { ...current.business, ...patch.business },
    tax: { ...current.tax, ...patch.tax },
    product: { ...current.product, ...patch.product },
    contact: { ...current.contact, ...patch.contact },
    sale: { ...current.sale, ...patch.sale },
    pos: { ...current.pos, ...patch.pos },
    displayScreen: { ...current.displayScreen, ...patch.displayScreen },
    purchases: { ...current.purchases, ...patch.purchases },
    payment: { ...current.payment, ...patch.payment },
    dashboard: { ...current.dashboard, ...patch.dashboard },
    system: { ...current.system, ...patch.system },
    prefixes: { ...current.prefixes, ...patch.prefixes },
    email: { ...current.email, ...patch.email },
    sms: { ...current.sms, ...patch.sms },
    rewardPoints: { ...current.rewardPoints, ...patch.rewardPoints },
    modules: { ...current.modules, ...patch.modules },
    customLabels: {
      ...current.customLabels,
      ...patch.customLabels,
    },
  };
}
