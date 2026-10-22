-- Track where each job part comes from (own stock, internal department, or
-- external supplier purchase). All columns are nullable to keep the migration
-- safe for existing multi-tenant JobMaterial rows.
ALTER TABLE "JobMaterial" ADD COLUMN IF NOT EXISTS "sourceType" TEXT;
ALTER TABLE "JobMaterial" ADD COLUMN IF NOT EXISTS "sourceDepartment" TEXT;
ALTER TABLE "JobMaterial" ADD COLUMN IF NOT EXISTS "supplierId" TEXT;
ALTER TABLE "JobMaterial" ADD COLUMN IF NOT EXISTS "supplierName" TEXT;
ALTER TABLE "JobMaterial" ADD COLUMN IF NOT EXISTS "purchaseMovementId" TEXT;
