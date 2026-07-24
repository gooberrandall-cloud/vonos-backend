export const REQUISITION_STATUSES = [
  "Pending",
  "Approved",
  "Fulfilled",
  "Rejected",
  "Cancelled",
] as const;

export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

/** A requested part line on a requisition. */
export interface RequisitionLine {
  itemId?: string | null;
  sku: string;
  name: string;
  quantity: number;
}

export interface Requisition {
  id: string;
  tenantId: string;
  reference: string;
  status: RequisitionStatus;
  jobId: string | null;
  notes: string | null;
  /** Source entity that fulfills the requisition (defaults to Warehouse). */
  sourceTenantId: string | null;
  lines: RequisitionLine[];
  fulfilledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRequisitionRequest {
  reference: string;
  jobId?: string;
  notes?: string;
  /** Source entity code (defaults to "VW" — Warehouse-first). */
  sourceTenantCode?: string;
  lines?: RequisitionLine[];
}
