export interface VariationTemplate {
  id: string;
  tenantId: string;
  name: string;
  values: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateVariationTemplateRequest {
  name: string;
  values: string[];
}

export interface UpdateVariationTemplateRequest {
  name?: string;
  values?: string[];
}
