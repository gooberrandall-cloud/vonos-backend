export interface Job {
  id: string;
  tenantId: string;
  reference: string;
  description: string;
  status: string;
  hasQuote: boolean;
  quoteAmount: number | null;
  customerName: string | null;
  vehicleId: string | null;
  locationCode: string | null;
  assignedStaffIds: string[];
  dueDate: string | null;
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
  source: string | null;
}

export interface JobLabour {
  id: string;
  jobId: string;
  staffId: string;
  staffName?: string | null;
  hours: number;
  rate: number;
  totalCost: number;
}
