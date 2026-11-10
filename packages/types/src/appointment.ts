export interface Appointment {
  id: string;
  tenantId: string;
  customerId: string;
  stylistId: string;
  serviceIds: string[];
  startTime: string;
  endTime: string;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Saloon calendar/list row shape from the appointments API. */
export interface AppointmentListRow {
  id: string;
  tenantId: string;
  customerId: string | null;
  customerName: string;
  stylistName: string;
  serviceName: string;
  servicePrice: number;
  currency: string;
  startTime: string;
  endTime: string;
  status: string;
  notes: string | null;
  locationCode: string | null;
}

export interface CreateAppointmentRequest {
  customerName?: string;
  stylistName: string;
  serviceName: string;
  servicePrice?: number;
  currency?: string;
  startTime: string;
  endTime: string;
  status?: string;
  notes?: string;
  locationCode?: string;
}
