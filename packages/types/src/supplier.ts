export interface Supplier {
  id: string;
  tenantId: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  locationCode: string | null;
  notes: string | null;
  taxNumber?: string | null;
  /** Supplier bank / account details. */
  accountHolderName?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  bankCode?: string | null;
  bankAccountNo?: string | null;
  taxPayerId?: string | null;
  openingBalance?: number;
  assignedToUserId?: string | null;
  assignedToName?: string | null;
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierFilters {
  cursor?: string;
  limit?: number;
  search?: string;
  purchaseDue?: boolean;
  purchaseReturn?: boolean;
  advanceBalance?: boolean;
  openingBalance?: boolean;
  assignedToUserId?: string;
  status?: "active" | "inactive";
  /** When false, skip count/amountSummary for faster first paint. */
  includeSummary?: boolean;
  /** List / picker sort — default name asc; use createdAt desc for recent pickers. */
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

/** List/detail row with display fields returned by the suppliers API. */
export interface SupplierListRow extends Supplier {
  category: string;
  leadTimeDays: number;
  location: string;
  rating: number;
  /** HQ6 contact id display (legacy or short id) */
  contactId?: string | null;
  businessName?: string | null;
  taxNumber?: string | null;
  payTerm?: string | null;
  totalPurchase?: number;
  totalPurchaseDue?: number;
  totalPurchasePaid?: number;
  totalPurchaseReturn?: number;
  totalAdvance?: number;
  status?: "active" | "inactive";
}
