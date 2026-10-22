-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN IF NOT EXISTS "sourceTenantCode" TEXT;
ALTER TABLE "SaleLine" ADD COLUMN IF NOT EXISTS "supplierId" TEXT;
