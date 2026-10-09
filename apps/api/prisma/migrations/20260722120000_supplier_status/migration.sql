-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS "Supplier_tenantId_status_idx" ON "Supplier"("tenantId", "status");
