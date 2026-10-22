import type { Archetype } from "./role";

export type ReportArchetypeFilter = Archetype | "*";

export type ReportSource =
  | { kind: "ledger"; handler: "pl" | "expenses" }
  | { kind: "reports"; tab: string }
  | { kind: "payments"; handler: "purchase" | "sell" }
  | {
      kind: "payment-accounts";
      handler: "balance-sheet" | "trial-balance" | "cash-flow" | "account-summary";
    }
  | { kind: "contacts"; handler: "summary" | "customer-groups" }
  | { kind: "stock"; handler: "valuation" | "lowstock" | "expiry" | "movement" | "details" }
  | { kind: "product"; handler: "trending" | "items" | "purchase" | "sell" }
  | { kind: "sales"; handler: "purchase-sale" | "tax" | "register" | "sales-rep" | "service-staff" }
  | { kind: "audit" };

export interface ReportRegistryEntry {
  id: string;
  label: string;
  slug: string;
  archetypes: ReportArchetypeFilter[];
  requiredModules?: string[];
  source: ReportSource;
  exportable?: boolean;
  groupRollup?: boolean;
}

/**
 * Legacy Ultimate POS report menu → Vonos report registry.
 * Same report list on every tenant (archetype/module filters disabled for nav parity).
 */
export const REPORT_REGISTRY: ReportRegistryEntry[] = [
  {
    id: "profit-loss",
    label: "Profit / Loss Report",
    slug: "report-profit-loss",
    archetypes: ["*"],
    source: { kind: "ledger", handler: "pl" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "purchase-sale",
    label: "Purchase & Sale",
    slug: "report-purchase-sale",
    archetypes: ["*"],
    source: { kind: "sales", handler: "purchase-sale" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "tax",
    label: "Tax Report",
    slug: "report-tax",
    archetypes: ["*"],
    source: { kind: "sales", handler: "tax" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "supplier-customer",
    label: "Supplier & Customer Report",
    slug: "report-supplier-customer",
    archetypes: ["*"],
    source: { kind: "contacts", handler: "summary" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "customer-groups",
    label: "Customer Groups Report",
    slug: "report-customer-groups",
    archetypes: ["*"],
    source: { kind: "contacts", handler: "customer-groups" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "stock",
    label: "Stock Report",
    slug: "report-stock",
    archetypes: ["*"],
    source: { kind: "stock", handler: "valuation" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "low-stock",
    label: "Low Stock Report",
    slug: "report-low-stock",
    archetypes: ["*"],
    source: { kind: "stock", handler: "lowstock" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "expiry",
    label: "Stock Expiry Report",
    slug: "report-expiry",
    archetypes: ["*"],
    source: { kind: "stock", handler: "expiry" },
    exportable: true,
    groupRollup: false,
  },
  {
    id: "stock-details",
    label: "Product Stock Details",
    slug: "report-stock-details",
    archetypes: ["*"],
    source: { kind: "stock", handler: "details" },
    exportable: true,
    groupRollup: false,
  },
  {
    id: "trending",
    label: "Trending Products",
    slug: "report-trending",
    archetypes: ["*"],
    source: { kind: "product", handler: "trending" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "items",
    label: "Items Report",
    slug: "report-items",
    archetypes: ["*"],
    source: { kind: "product", handler: "items" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "product-purchase",
    label: "Product Purchase Report",
    slug: "report-product-purchase",
    archetypes: ["*"],
    source: { kind: "product", handler: "purchase" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "product-sell",
    label: "Product Sell Report",
    slug: "report-product-sell",
    archetypes: ["*"],
    source: { kind: "product", handler: "sell" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "purchase-payment",
    label: "Purchase Payment Report",
    slug: "report-purchase-payment",
    archetypes: ["*"],
    source: { kind: "payments", handler: "purchase" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "sell-payment",
    label: "Sell Payment Report",
    slug: "report-sell-payment",
    archetypes: ["*"],
    source: { kind: "payments", handler: "sell" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "expense",
    label: "Expense Report",
    slug: "report-expense",
    archetypes: ["*"],
    source: { kind: "ledger", handler: "expenses" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "register",
    label: "Register Report",
    slug: "report-register",
    archetypes: ["*"],
    source: { kind: "sales", handler: "register" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "sales-rep",
    label: "Sales Representative Report",
    slug: "report-sales-rep",
    archetypes: ["*"],
    source: { kind: "sales", handler: "sales-rep" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "service-staff",
    label: "Service Staff Report",
    slug: "report-service-staff",
    archetypes: ["*"],
    source: { kind: "sales", handler: "service-staff" },
    exportable: true,
    groupRollup: false,
  },
  {
    id: "activity-log",
    label: "Activity Log",
    slug: "report-activity-log",
    archetypes: ["*"],
    source: { kind: "audit" },
    exportable: true,
    groupRollup: true,
  },
  {
    id: "balance-sheet",
    label: "Balance Sheet",
    slug: "balance-sheet",
    archetypes: ["*"],
    source: { kind: "payment-accounts", handler: "balance-sheet" },
    exportable: true,
    groupRollup: false,
  },
  {
    id: "trial-balance",
    label: "Trial Balance",
    slug: "trial-balance",
    archetypes: ["*"],
    source: { kind: "payment-accounts", handler: "trial-balance" },
    exportable: true,
    groupRollup: false,
  },
  {
    id: "cash-flow",
    label: "Cash Flow",
    slug: "cash-flow",
    archetypes: ["*"],
    source: { kind: "payment-accounts", handler: "cash-flow" },
    exportable: true,
    groupRollup: false,
  },
  {
    id: "payment-account-report",
    label: "Payment Account Report",
    slug: "payment-account-report",
    archetypes: ["*"],
    source: { kind: "payment-accounts", handler: "account-summary" },
    exportable: true,
    groupRollup: false,
  },
];

export function reportEntryById(id: string): ReportRegistryEntry | undefined {
  return REPORT_REGISTRY.find((entry) => entry.id === id);
}

export function reportEntryBySlug(slug: string): ReportRegistryEntry | undefined {
  return REPORT_REGISTRY.find((entry) => entry.slug === slug);
}

/** Full report list for every tenant — same sidebar / hub everywhere. */
export function reportsForArchetype(
  _archetype: Archetype,
  _enabledModules: string[],
): ReportRegistryEntry[] {
  return REPORT_REGISTRY;
}
