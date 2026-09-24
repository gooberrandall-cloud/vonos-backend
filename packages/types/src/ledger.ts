export const LEDGER_ENTRY_TYPES = ["revenue", "cost", "expense"] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export interface LedgerEntry {
  id: string;
  tenantId: string;
  type: LedgerEntryType;
  amount: number;
  currency: string;
  category: string;
  description: string;
  linkedRecordType: string | null;
  linkedRecordId: string | null;
  date: string;
  createdAt: string;
}

export interface LedgerSummary {
  revenue: number;
  costs: number;
  net: number;
  outstanding: number;
  currency: string;
}

/** Ledger row with entity context for VAG group roll-up views. */
export interface LedgerListRow extends LedgerEntry {
  tenantCode: string | null;
  tenantName: string | null;
}

/** Per-entity finance roll-up for super-admin group views. */
export interface LedgerEntitySummary extends LedgerSummary {
  tenantId: string;
  tenantCode: string;
  tenantName: string;
}

export interface CreateManualExpenseRequest {
  type: "expense";
  amount: number;
  category: string;
  description: string;
  date?: string;
  currency?: string;
}
