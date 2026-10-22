-- Report query performance indexes
CREATE INDEX IF NOT EXISTS "Job_tenantId_updatedAt_idx" ON "Job"("tenantId", "updatedAt");
CREATE INDEX IF NOT EXISTS "LedgerEntry_tenantId_type_date_idx" ON "LedgerEntry"("tenantId", "type", "date");
CREATE INDEX IF NOT EXISTS "Sale_tenantId_status_date_idx" ON "Sale"("tenantId", "status", "date");
