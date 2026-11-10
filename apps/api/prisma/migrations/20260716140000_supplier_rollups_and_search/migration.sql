-- Supplier purchase rollups + additional trigram indexes for remaining search hot paths.

ALTER TABLE "Supplier"
  ADD COLUMN IF NOT EXISTS "totalPurchase" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalPurchaseDue" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalPurchasePaid" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalPurchaseReturn" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalAdvance" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastPurchaseAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Supplier_tenantId_totalPurchaseDue_idx"
  ON "Supplier" ("tenantId", "totalPurchaseDue");

CREATE INDEX IF NOT EXISTS "Supplier_tenantId_lastPurchaseAt_idx"
  ON "Supplier" ("tenantId", "lastPurchaseAt");

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Job_reference_trgm_idx"
  ON "Job" USING gin ("reference" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Job_customerName_trgm_idx"
  ON "Job" USING gin ("customerName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Invoice_reference_trgm_idx"
  ON "Invoice" USING gin ("reference" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Invoice_contactName_trgm_idx"
  ON "Invoice" USING gin ("contactName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Notification_tenantId_userId_read_createdAt_idx"
  ON "Notification" ("tenantId", "userId", "read", "createdAt");
