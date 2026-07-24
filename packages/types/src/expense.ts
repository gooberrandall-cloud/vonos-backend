export interface ExpenseCategory {
  id: string;
  tenantId: string;
  name: string;
  code: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Expense {
  id: string;
  tenantId: string;
  refNo: string | null;
  categoryId: string | null;
  categoryName: string | null;
  subCategory: string | null;
  locationCode: string | null;
  expenseForCustomerId: string | null;
  expenseFor: string | null;
  contactCustomerId: string | null;
  contactName: string | null;
  totalAmount: number;
  taxAmount: number;
  paymentStatus: string;
  paymentDue: number;
  note: string | null;
  isRecurring: boolean;
  recurInterval: number | null;
  recurIntervalType: string | null;
  expenseDate: string;
  createdById: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseFilters {
  cursor?: string;
  limit?: number;
  search?: string;
  from?: string;
  to?: string;
  locationCode?: string;
  expenseForCustomerId?: string;
  contactCustomerId?: string;
  createdById?: string;
  categoryId?: string;
  paymentStatus?: string;
  /** When false, skip count/amountSummary for faster first paint. */
  includeSummary?: boolean;
}

export interface CreateExpenseRequest {
  categoryId?: string;
  refNo?: string;
  subCategory?: string;
  locationCode?: string;
  expenseForCustomerId?: string;
  contactCustomerId?: string;
  /** @deprecated use expenseForCustomerId */
  expenseFor?: string;
  /** @deprecated use contactCustomerId */
  contactName?: string;
  totalAmount: number;
  taxAmount?: number;
  paymentStatus?: string;
  note?: string;
  isRecurring?: boolean;
  recurInterval?: number;
  recurIntervalType?: string;
  expenseDate?: string;
}

export interface CreateExpenseCategoryRequest {
  name: string;
  code?: string;
}

export interface UpdateExpenseCategoryRequest {
  name?: string;
  code?: string;
}

export interface UpdateExpenseRequest {
  categoryId?: string | null;
  refNo?: string | null;
  subCategory?: string | null;
  locationCode?: string | null;
  expenseForCustomerId?: string | null;
  contactCustomerId?: string | null;
  expenseFor?: string | null;
  contactName?: string | null;
  totalAmount?: number;
  taxAmount?: number;
  paymentStatus?: string;
  paymentDue?: number;
  note?: string | null;
  isRecurring?: boolean;
  recurInterval?: number | null;
  recurIntervalType?: string | null;
  expenseDate?: string;
}
