export interface ProductCategory {
  id: string;
  tenantId: string;
  name: string;
  shortCode: string | null;
  parentId: string | null;
  categoryType: string | null;
  description: string | null;
  slug: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Brand {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductUnit {
  id: string;
  tenantId: string;
  name: string;
  shortName: string;
  allowDecimal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Warranty {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  duration: number;
  durationType: "days" | "months" | "years";
  createdAt: string;
  updatedAt: string;
}

export interface SellingPriceGroup {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProductCategoryInput {
  name: string;
  shortCode?: string;
  description?: string;
  categoryType?: string;
}

export interface CreateBrandInput {
  name: string;
  description?: string;
}

export interface CreateProductUnitInput {
  name: string;
  shortName: string;
  allowDecimal?: boolean;
}

export interface CreateWarrantyInput {
  name: string;
  duration: number;
  durationType: "days" | "months" | "years";
  description?: string;
}

export interface CreateSellingPriceGroupInput {
  name: string;
  description?: string;
  isActive?: boolean;
}
