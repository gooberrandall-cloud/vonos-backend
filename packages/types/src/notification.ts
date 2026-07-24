export type NotificationSeverity = "success" | "warning" | "error" | "info";

export interface Notification {
  id: string;
  tenantId: string | null;
  userId: string | null;
  type: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
  linkedRecordType: string | null;
  linkedRecordId: string | null;
  read: boolean;
  createdAt: string;
}
