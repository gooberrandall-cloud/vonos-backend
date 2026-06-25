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
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** List/detail row with display fields returned by the suppliers API. */
export interface SupplierListRow extends Supplier {
  category: string;
  leadTimeDays: number;
  location: string;
  rating: number;
}
