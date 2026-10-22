-- DropIndex (idempotent)
DROP INDEX IF EXISTS "Job_reference_key";

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "Job_tenantId_reference_key" ON "Job"("tenantId", "reference");
