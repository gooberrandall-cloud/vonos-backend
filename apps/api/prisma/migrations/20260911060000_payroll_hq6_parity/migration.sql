-- HQ6 payroll group parity: group status/location/audit + pay component extensions.

ALTER TABLE "PayrollGroup"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "locationCode" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByName" TEXT;

CREATE INDEX IF NOT EXISTS "PayrollGroup_tenantId_status_idx"
  ON "PayrollGroup"("tenantId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollGroup_createdByUserId_fkey'
  ) THEN
    ALTER TABLE "PayrollGroup"
      ADD CONSTRAINT "PayrollGroup_createdByUserId_fkey"
      FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "PayComponent"
  ADD COLUMN IF NOT EXISTS "amountType" TEXT NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS "applicableDate" DATE,
  ADD COLUMN IF NOT EXISTS "employeeRecordId" TEXT;

CREATE INDEX IF NOT EXISTS "PayComponent_tenantId_employeeRecordId_idx"
  ON "PayComponent"("tenantId", "employeeRecordId");
