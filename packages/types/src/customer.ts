export interface Customer {
  id: string;
  tenantId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Aggregated from sales — not stored on Customer row */
  totalSpend: number;
  /** Aggregated from sales — not stored on Customer row */
  visitCount: number;
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerFilters {
  cursor?: string;
  limit?: number;
  search?: string;
}
