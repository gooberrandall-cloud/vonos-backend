export type PayrollStatus = "draft" | "final" | "paid";
export type PayComponentType = "allowance" | "deduction";

export interface Payroll {
  id: string;
  tenantId: string;
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
}

export interface PayrollGroup {
  id: string;
  tenantId: string;
  name: string;
  payrollCount: number;
  createdAt: string;
}

export interface Designation {
  id: string;
  tenantId: string;
  name: string;
  employeeCount: number;
  createdAt: string;
}

export interface Employee {
  id: string;
  tenantId: string;
  name: string;
  employeeCode: string | null;
  locationCode: string | null;
  payrollGroupId: string | null;
  payrollGroupName: string | null;
  designationId: string;
  designationName: string;
  userId: string | null;
  isServiceStaff: boolean;
  createdAt: string;
}

export interface PayComponent {
  id: string;
  tenantId: string;
  name: string;
  type: PayComponentType;
  amount: number;
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
  grossPay: number;
  totalAllowance?: number;
  totalDeduction?: number;
  payrollMonth: string;
  note?: string;
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

export interface CreatePayrollGroupRequest {
  name: string;
}

export interface CreateDesignationRequest {
  name: string;
}

export interface CreateEmployeeRequest {
  name: string;
  employeeCode?: string;
  locationCode?: string;
  payrollGroupId?: string;
  designationId: string;
  userId?: string;
  isServiceStaff?: boolean;
}

export interface CreatePayComponentRequest {
  name: string;
  type: PayComponentType;
  amount: number;
}

export interface PayrollFilters {
  cursor?: string;
  limit?: number;
  search?: string;
  payrollGroupId?: string;
  employeeRecordId?: string;
  locationCode?: string;
  designationId?: string;
  month?: number;
  year?: number;
  status?: string;
  paymentStatus?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
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
  designationId?: string | null;
  designationName?: string | null;
  payrollGroupId?: string | null;
  payrollGroupName?: string | null;
  payrollCount: number;
  lastPayrollMonth: string;
  totalNetPay: number;
}
