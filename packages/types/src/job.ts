export interface Job {
  id: string;
  tenantId: string;
  reference: string;
  description: string;
  status: string;
  hasQuote: boolean;
  quoteAmount: number | null;
  quoteNotes: string | null;
  quoteValidUntil: string | null;
  invoiceAmount: number | null;
  invoiceNotes: string | null;
  /** Linked commercial sale when jobs and sales are the same (VA). */
  saleId?: string | null;
  customerName: string | null;
  customerId: string | null;
  vehicleId: string | null;
  locationCode: string | null;
  assignedStaffIds: string[];
  dueDate: string | null;
  qcChecklist: Record<string, boolean> | null;
  qcNotes: string | null;
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobMaterial {
  id: string;
  jobId: string;
  itemId: string | null;
  name: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  /** Catalog SKU when itemId is set — avoids a second item fetch for requisitions. */
  sku?: string | null;
  source: string | null;
  /** Where the part comes from: own shop stock, an internal department, or an external purchase. */
  sourceType: JobMaterialSourceType | null;
  /** Tenant code of the supplying department when sourceType is "internal". */
  sourceDepartment: string | null;
  /** Supplier used for an external purchase (sourceType "external"). */
  supplierId: string | null;
  supplierName: string | null;
  /** Linked purchase (inbound stock movement) created for an external part. */
  purchaseMovementId: string | null;
}

export const JOB_MATERIAL_SOURCE_TYPES = [
  "shop",
  "internal",
  "external",
] as const;

export type JobMaterialSourceType = (typeof JOB_MATERIAL_SOURCE_TYPES)[number];

export interface JobLabour {
  id: string;
  jobId: string;
  staffId: string;
  staffName?: string | null;
  hours: number;
  rate: number;
  totalCost: number;
}

export interface CreateJobMaterialRequest {
  itemId?: string;
  name: string;
  quantity: number;
  unitCost: number;
  source?: string;
  sourceType?: JobMaterialSourceType;
  /** Required when sourceType is "internal" — tenant code of the supplying department. */
  sourceDepartment?: string;
  /** Required when sourceType is "external" — supplier for the purchase. */
  supplierId?: string;
}

export interface UpdateJobMaterialRequest {
  name?: string;
  quantity?: number;
  unitCost?: number;
  source?: string | null;
}

export interface CreateJobLabourRequest {
  staffId: string;
  hours: number;
  rate: number;
}

export interface UpdateJobLabourRequest {
  staffId?: string;
  hours?: number;
  rate?: number;
}
