export interface Vehicle {
  id: string;
  tenantId: string;
  plateNumber: string;
  vin: string | null;
  make: string;
  model: string;
  year: number | null;
  ownerName: string;
  ownerPhone: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VehicleJobHistoryEntry {
  id: string;
  reference: string;
  status: string;
  customerName: string | null;
  dueDate: string | null;
  quoteAmount: number | null;
  invoiceAmount: number | null;
}
