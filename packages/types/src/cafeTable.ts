export const CAFE_TABLE_STATUSES = ["available", "occupied", "reserved"] as const;

export type CafeTableStatus = (typeof CAFE_TABLE_STATUSES)[number];

export interface CafeTable {
  id: string;
  tenantId: string;
  label: string;
  status: CafeTableStatus;
  capacity: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCafeTableRequest {
  label: string;
  capacity?: number;
  status?: CafeTableStatus;
}

export interface UpdateCafeTableStatusRequest {
  status: CafeTableStatus;
}
