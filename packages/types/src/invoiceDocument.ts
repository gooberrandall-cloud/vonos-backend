export type InvoiceKind =
  | "sale"
  | "purchase"
  | "expense"
  | "payroll"
  | "payroll_group"
  | "job_invoice"
  | "job_quote";

export interface InvoiceListRow {
  id: string;
  tenantId: string;
  reference: string;
  kind: InvoiceKind;
  status: string;
  paymentStatus: string | null;
  currency: string;
  total: number;
  documentDate: string;
  contactName: string | null;
  customerId: string | null;
  supplierId: string | null;
  employeeRecordId: string | null;
  saleId: string | null;
  stockMovementId: string | null;
  expenseId: string | null;
  payrollId: string | null;
  payrollGroupId: string | null;
  jobId: string | null;
  createdAt: string;
}

export interface InvoiceLinePreview {
  label: string;
  kind?: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface InvoiceDetail extends InvoiceListRow {
  subtotal: number | null;
  taxAmount: number | null;
  discountAmount: number | null;
  dueDate: string | null;
  notes: string | null;
  layoutId: string | null;
  schemeId: string | null;
  lineItems: InvoiceLinePreview[];
  linkedRecordType: string | null;
  linkedRecordId: string | null;
}
