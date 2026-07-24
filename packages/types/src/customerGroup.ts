export interface CustomerGroup {
  id: string;
  tenantId: string;
  name: string;
  discountPercent: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomerGroupRequest {
  name: string;
  discountPercent?: number;
}

export interface UpdateCustomerGroupRequest {
  name?: string;
  discountPercent?: number;
}
