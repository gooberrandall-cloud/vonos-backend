export const REQUISITION_STATUSES = [
  "Pending",
  "Approved",
  "Fulfilled",
  "Rejected",
] as const;

export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

export interface Requisition {
  id: string;
  tenantId: string;
  reference: string;
  status: RequisitionStatus;
  jobId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRequisitionRequest {
  reference: string;
  jobId?: string;
  notes?: string;
}
