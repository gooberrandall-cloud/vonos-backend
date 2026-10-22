-- Hot list / report filter indexes (date, status, search).
-- Trigram indexes require pg_trgm (created in 20260716120000_perf_rollups_trigram).

CREATE INDEX IF NOT EXISTS "Customer_tenantId_createdAt_idx"
  ON "Customer" ("tenantId", "createdAt");

CREATE INDEX IF NOT EXISTS "Payment_tenantId_createdAt_idx"
  ON "Payment" ("tenantId", "createdAt");

CREATE INDEX IF NOT EXISTS "User_tenantId_role_idx"
  ON "User" ("tenantId", "role");

CREATE INDEX IF NOT EXISTS "User_tenantId_status_idx"
  ON "User" ("tenantId", "status");

CREATE INDEX IF NOT EXISTS "User_tenantId_name_idx"
  ON "User" ("tenantId", "name");

CREATE INDEX IF NOT EXISTS "StockMovement_tenantId_type_status_idx"
  ON "StockMovement" ("tenantId", "type", "status");

CREATE INDEX IF NOT EXISTS "Appointment_tenantId_status_startTime_idx"
  ON "Appointment" ("tenantId", "status", "startTime");

CREATE INDEX IF NOT EXISTS "Item_tenantId_category_idx"
  ON "Item" ("tenantId", "category");

-- Active-row helpers for stock valuation / soft-delete filters.
CREATE INDEX IF NOT EXISTS "Item_tenantId_deletedAt_idx"
  ON "Item" ("tenantId", "deletedAt");

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Job_reference_trgm_idx"
  ON "Job" USING gin ("reference" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Job_customerName_trgm_idx"
  ON "Job" USING gin ("customerName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Vehicle_plateNumber_trgm_idx"
  ON "Vehicle" USING gin ("plateNumber" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "StockMovement_reference_trgm_idx"
  ON "StockMovement" USING gin ("reference" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "User_name_trgm_idx"
  ON "User" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "User_email_trgm_idx"
  ON "User" USING gin ("email" gin_trgm_ops);
