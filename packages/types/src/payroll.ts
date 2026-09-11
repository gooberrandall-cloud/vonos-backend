export type PayrollStatus = "draft" | "final" | "paid";
export type PayComponentType = "allowance" | "deduction";

export interface Payroll {
  id: string;
  tenantId: string;
  /** Present on VAG all-tenants payroll lists. */
  tenantCode?: string | null;
  tenantName?: string | null;
  payrollGroupId: string | null;
  payrollGroupName: string | null;
  employeeRecordId: string | null;
  designationId: string | null;
  designationName: string | null;
  employeeName: string;
  employeeId: string | null;
  locationCode: string | null;
  grossPay: number;
  totalAllowance: number;
  totalDeduction: number;
  netPay: number;
  status: PayrollStatus;
  paymentStatus: string;
  payrollMonth: string;
  note: string | null;
  createdAt: string;
  /** From linked Employee / Ultimate POS users.bank_details. */
  accountHolderName?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  bankCode?: string | null;
  bankAccountNo?: string | null;
  taxPayerId?: string | null;
  /** HQ6 payslip reference (VPR-YYYY/nnn). */
  referenceNo?: string | null;
  department?: string | null;
}

export type PayrollGroupStatus = "draft" | "final";

export interface PayrollGroup {
  id: string;
  tenantId: string;
  name: string;
  /** Department ID / short code (HQ6 Manage Departments). */
  code?: string | null;
  description?: string | null;
  status: PayrollGroupStatus;
  paymentStatus: "due" | "partial" | "paid";
  totalGross: number;
  locationCode: string | null;
  createdByName: string | null;
  payrollCount: number;
  createdAt: string;
}

/** Full group detail for View/Edit pages. */
export interface PayrollGroupDetail extends PayrollGroup {
  payrolls: Payroll[];
}

export interface PayrollGroupEmployeeUpdate {
  payrollId: string;
  grossPay: number;
  totalAllowance?: number;
  totalDeduction?: number;
  note?: string;
}

export interface UpdatePayrollGroupPayrollsRequest {
  name?: string;
  status?: PayrollGroupStatus;
  locationCode?: string;
  sendNotification?: boolean;
  employees: PayrollGroupEmployeeUpdate[];
}

export interface PayrollPaymentRow {
  id: string;
  paidOn: string | null;
  paymentRefNo: string | null;
  amount: number;
  method: string | null;
  note: string | null;
  accountName: string | null;
  /** User who authorized / recorded the payment. */
  authorizedByName: string | null;
}

export interface Designation {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  employeeCount: number;
  createdAt: string;
}

export interface Employee {
  id: string;
  tenantId: string;
  name: string;
  employeeCode: string | null;
  locationCode: string | null;
  /** Allocated business location codes (multi-select). */
  locationCodes: string[];
  payrollGroupId: string | null;
  payrollGroupName: string | null;
  designationId: string;
  designationName: string;
  userId: string | null;
  isServiceStaff: boolean;
  accountHolderName: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankCode: string | null;
  bankAccountNo: string | null;
  taxPayerId: string | null;
  mobile: string | null;
  altContact: string | null;
  familyContact: string | null;
  guardianName: string | null;
  /** ISO date (YYYY-MM-DD) when set. */
  dateOfBirth: string | null;
  gender: string | null;
  maritalStatus: string | null;
  bloodGroup: string | null;
  idProofName: string | null;
  idProofNumber: string | null;
  permanentAddress: string | null;
  currentAddress: string | null;
  salesCommission: number | null;
  maxSalesDiscountPercent: number | null;
  department: string | null;
  createdAt: string;
}

/** Staff group for Add Payroll filters. */
export type PayrollStaffBucket =
  | "management"
  | "technical"
  | "service"
  | "other";

/**
 * User-backed payroll pick row for a tenant (home users + peer Employee copies).
 * `name` is always the linked User's display name.
 */
export interface PayrollCandidate {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  employeeCode: string | null;
  locationCode: string | null;
  locationCodes: string[];
  payrollGroupId: string | null;
  payrollGroupName: string | null;
  designationId: string;
  designationName: string;
  department: string | null;
  isServiceStaff: boolean;
  staffBucket: PayrollStaffBucket;
  tenantRoleName: string | null;
}

export type PayComponentAmountType = "fixed" | "percent";

export interface PayComponent {
  id: string;
  tenantId: string;
  name: string;
  type: PayComponentType;
  amountType: PayComponentAmountType;
  amount: number;
  applicableDate: string | null;
  employeeRecordId: string | null;
  employeeName?: string | null;
  createdAt: string;
}

export interface CreatePayrollRequest {
  /** Preferred: pick from workforce Employee record (required for new payrolls). */
  employeeRecordId?: string;
  employeeName?: string;
  employeeId?: string;
  payrollGroupId?: string;
  designationId?: string;
  locationCode?: string;
  /** Basic salary total (duration × amount per unit). */
  grossPay: number;
  totalAllowance?: number;
  totalDeduction?: number;
  /** draft | final | paid — defaults to draft. */
  status?: "draft" | "final" | "paid";
  payrollMonth: string;
  note?: string;
}

/** Change payroll lifecycle status (draft ↔ final). Payment sets `paid`. */
export interface UpdatePayrollStatusRequest {
  status: Extract<PayrollStatus, "draft" | "final">;
}

/** Add (or set) deduction on an existing payroll run. */
export interface UpdatePayrollDeductionRequest {
  /** Absolute deduction total. Prefer `addAmount` for incremental adds. */
  totalDeduction?: number;
  /** Amount to add on top of the current deduction total. */
  addAmount?: number;
  /** Pay component label or deduction type (e.g. PAYE). */
  note?: string;
  /** Why this deduction was applied — shown on payslip. */
  reason?: string;
}

/** Mark one or more payroll runs paid and debit a payment account. */
export interface PayPayrollsRequest {
  payrollIds: string[];
  accountId: string;
  method?: string;
  paidOn?: string;
  note?: string;
}

export interface PayPayrollsResult {
  paid: number;
  skipped: number;
  totalDebited: number;
  accountId: string;
  accountName: string;
  payrolls: Payroll[];
}

export interface CreatePayrollGroupRequest {
  name: string;
  code?: string;
  description?: string;
  locationCode?: string;
  status?: PayrollGroupStatus;
}

export interface UpdatePayrollGroupRequest {
  name?: string;
  code?: string | null;
  description?: string | null;
  locationCode?: string | null;
  status?: PayrollGroupStatus;
}

export interface UpdatePayrollGroupStatusRequest {
  status: PayrollGroupStatus;
}

export interface CreateDesignationRequest {
  name: string;
  description?: string;
}

export interface UpdateDesignationRequest {
  name?: string;
  description?: string | null;
}

export interface CreateEmployeeRequest {
  name: string;
  employeeCode?: string;
  /** @deprecated Prefer locationCodes for multi-location allocation. */
  locationCode?: string;
  locationCodes?: string[];
  payrollGroupId?: string;
  designationId: string;
  userId?: string;
  isServiceStaff?: boolean;
  accountHolderName?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  bankCode?: string | null;
  bankAccountNo?: string | null;
  taxPayerId?: string | null;
  mobile?: string | null;
  altContact?: string | null;
  familyContact?: string | null;
  guardianName?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  maritalStatus?: string | null;
  bloodGroup?: string | null;
  idProofName?: string | null;
  idProofNumber?: string | null;
  permanentAddress?: string | null;
  currentAddress?: string | null;
  salesCommission?: number | null;
  maxSalesDiscountPercent?: number | null;
  department?: string | null;
}

/** Patch employee linked to a login user (locations + HR/bank fields). */
export interface SyncEmployeeByUserRequest {
  locationCodes?: string[];
  locationCode?: string | null;
  name?: string;
  designationId?: string;
  /** When set, overrides role/designation derivation for the sales service-staff roster. */
  isServiceStaff?: boolean;
  accountHolderName?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  bankCode?: string | null;
  bankAccountNo?: string | null;
  taxPayerId?: string | null;
  mobile?: string | null;
  altContact?: string | null;
  familyContact?: string | null;
  guardianName?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  maritalStatus?: string | null;
  bloodGroup?: string | null;
  idProofName?: string | null;
  idProofNumber?: string | null;
  permanentAddress?: string | null;
  currentAddress?: string | null;
  salesCommission?: number | null;
  maxSalesDiscountPercent?: number | null;
  department?: string | null;
}

export interface CreatePayComponentRequest {
  name: string;
  type: PayComponentType;
  amount: number;
  amountType?: PayComponentAmountType;
  applicableDate?: string;
  employeeRecordId?: string;
}

export interface UpdatePayComponentRequest {
  name?: string;
  type?: PayComponentType;
  amount?: number;
  amountType?: PayComponentAmountType;
  applicableDate?: string | null;
  employeeRecordId?: string | null;
}

export interface PayrollFilters {
  cursor?: string;
  limit?: number;
  search?: string;
  payrollGroupId?: string;
  employeeRecordId?: string;
  locationCode?: string;
  designationId?: string;
  department?: string;
  /** Filter all-tenants lists to one entity code (e.g. VA). */
  tenantCode?: string;
  month?: number;
  year?: number;
  status?: string;
  paymentStatus?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  includeSummary?: boolean;
}

/** Distinct employee roster derived from imported payroll history / Employee table. */
export interface WorkforceMember {
  id: string;
  tenantId: string;
  tenantCode?: string | null;
  tenantName?: string | null;
  employeeName: string;
  employeeId: string | null;
  locationCode: string | null;
  locationCodes?: string[];
  designationId?: string | null;
  designationName?: string | null;
  payrollGroupId?: string | null;
  payrollGroupName?: string | null;
  payrollCount: number;
  lastPayrollMonth: string;
  totalNetPay: number;
}

export interface WorkforceStats {
  totalCount: number;
  byLocation: Array<{ locationCode: string | null; count: number }>;
}
