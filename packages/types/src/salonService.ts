export interface SalonService {
  id: string;
  tenantId: string;
  name: string;
  durationMinutes: number;
  price: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSalonServiceRequest {
  name: string;
  durationMinutes?: number;
  price: number;
  currency?: string;
}
