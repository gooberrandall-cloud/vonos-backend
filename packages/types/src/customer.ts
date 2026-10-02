import type { CustomerContactDetails } from "./customerContactDetails";

export interface Customer {
  id: string;
  tenantId: string;
  name: string;
  email: string | null;
  phone: string | null;
  customerGroupId?: string | null;
  customerGroupName?: string | null;
  assignedToUserId?: string | null;
  assignedToName?: string | null;
  openingBalance?: number;
  /** Aggregated from sales — not stored on Customer row */
  totalSpend: number;
  /** Aggregated from sales — not stored on Customer row */
  visitCount: number;
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
  /** HQ6 list parity fields */
  contactId?: string | null;
  businessName?: string | null;
  taxNumber?: string | null;
  totalSell?: number;
  totalSellDue?: number;
  totalSellPaid?: number;
  totalSellReturn?: number;
  totalAdvance?: number;
  status?: "active" | "inactive";
  /** Ultimate POS contact form extras */
  details?: CustomerContactDetails | null;
}

export interface CustomerFilters {
  cursor?: string;
  limit?: number;
  search?: string;
  sellDue?: boolean;
  sellReturn?: boolean;
  advanceBalance?: boolean;
  openingBalance?: boolean;
  hasNoSellMonths?: 1 | 3 | 6 | 12;
  customerGroupId?: string;
  assignedToUserId?: string;
  /** HRM employee (worker) assigned to the contact — details.assignedToEmployeeId. */
  assignedToEmployeeId?: string;
  status?: "active" | "inactive";
  /** ISO date — filter by customer createdAt >= from */
  from?: string;
  /** ISO date — filter by customer createdAt <= to */
  to?: string;
  /** When false, skip count/amountSummary for faster first paint. */
  includeSummary?: boolean;
  /**
   * Typeahead / option-list mode: skip the legacy Contact ID resolution
   * round-trip (pickers only render the name). Saves one Neon round-trip.
   */
  lite?: boolean;
  /** List sort — default createdAt desc (newest first). */
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

export interface CreateCustomerInput {
  name: string;
  email?: string;
  phone?: string;
  customerGroupId?: string;
  assignedToUserId?: string;
  openingBalance?: number;
  status?: "active" | "inactive";
  taxNumber?: string | null;
  details?: CustomerContactDetails | null;
}

export interface UpdateCustomerInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  customerGroupId?: string | null;
  assignedToUserId?: string | null;
  openingBalance?: number;
  status?: "active" | "inactive";
  taxNumber?: string | null;
  details?: CustomerContactDetails | null;
}

export interface PayContactDueRequest {
  amount: number;
  method?: string;
  accountId?: string;
  note?: string;
  paidOn?: string;
}

export interface PayContactDueResult {
  contactId: string;
  amountApplied: number;
  currency: string;
  paymentsCreated: number;
  remainingDue: number;
}

export type CustomerTransactionKind = "sale" | "job" | "appointment";

export interface CustomerTransactionHistoryEntry {
  id: string;
  kind: CustomerTransactionKind;
  reference: string;
  date: string;
  amount: number;
  currency: string;
  status?: string;
  paymentStatus?: string | null;
}

/** Customer detail with purchase/job history for profile + invoices */
export interface CustomerProfile extends Customer {
  transactionHistory: CustomerTransactionHistoryEntry[];
}

export interface ContactDueSummary {
  contactId: string;
  totalAmount: number;
  totalPaid: number;
  totalDue: number;
  currency: string;
}

/** Lightweight customer row for titles, forms, and invoice contact — no history. */
export interface CustomerContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  totalSellDue: number;
  /** Credit / overpayment available to apply on the next sale. */
  totalAdvance: number;
  visitCount: number;
  createdAt: string;
  status: "active" | "inactive";
  /** Vehicle registration / Contact ID (automotive plate). */
  contactId?: string | null;
  businessName?: string | null;
  /** Ultimate POS contact form extras (mileage, car model, location, …). */
  details?: CustomerContactDetails | null;
}

export interface ContactLedgerEntry {
  id: string;
  date: string;
  type: string;
  description: string;
  amount: number;
  currency: string;
  linkedRecordType?: string | null;
  linkedRecordId?: string | null;
  reference?: string | null;
}

/** Customer modal: contact + due summary + ledger in one round-trip. */
export interface CustomerViewBundle {
  customer: CustomerContact;
  summary: ContactDueSummary;
  ledger: ContactLedgerEntry[];
}

export interface CsvImportResult {
  created: number;
  updated: number;
  errors: Array<{ row: number; message: string }>;
}
