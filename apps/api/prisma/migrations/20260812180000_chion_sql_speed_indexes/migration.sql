-- Chion speed bench follow-ups: partial list indexes + job status/date composite.
-- Matches deletedAt IS NULL list filters (same pattern as va_list_order_indexes).

CREATE INDEX IF NOT EXISTS "Payment_tenantId_createdAt_id_active_idx"
  ON "Payment" ("tenantId", "createdAt" DESC, id DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Payment_tenantId_paidOn_id_active_idx"
  ON "Payment" ("tenantId", "paidOn" DESC NULLS LAST, id DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Job_tenantId_createdAt_id_active_idx"
  ON "Job" ("tenantId", "createdAt" DESC, id DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Job_tenantId_status_createdAt_active_idx"
  ON "Job" ("tenantId", status, "createdAt")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "LedgerEntry_tenantId_date_id_active_idx"
  ON "LedgerEntry" ("tenantId", date DESC, id DESC)
  WHERE "deletedAt" IS NULL;
