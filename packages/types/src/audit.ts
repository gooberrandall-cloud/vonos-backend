export type AuditAction =
  | "created"
  | "updated"
  | "deleted"
  | "login"
  | "payment_edited"
  | "added"
  | "edited";

export type AuditEntityType =
  | "sale"
  | "job"
  | "item"
  | "customer"
  | "supplier"
  | "stockMovement"
  | "user";

export interface AuditLogEntry {
  id: string;
  tenantId: string;
  action: AuditAction | string;
  entityType: AuditEntityType | string;
  entityId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  summary: string;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
}

export interface AuditLogFilters {
  entityType?: string;
  entityId?: string;
  cursor?: string;
  limit?: number;
}

export interface CreatedByFields {
  createdByUserId?: string | null;
  createdByName?: string | null;
}
