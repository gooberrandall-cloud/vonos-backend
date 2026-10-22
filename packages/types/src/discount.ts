export const DISCOUNT_TYPES = ["fixed", "percentage"] as const;

export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export interface Discount {
  id: string;
  tenantId: string;
  name: string;
  discountType: DiscountType;
  amount: number;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDiscountRequest {
  name: string;
  discountType: DiscountType;
  amount: number;
  isActive?: boolean;
  startsAt?: string;
  endsAt?: string;
}

export interface UpdateDiscountRequest extends Partial<CreateDiscountRequest> {}
