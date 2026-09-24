-- Link sales to jobs (VA: every sale is the commercial record for a job).
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "jobId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Sale_tenantId_jobId_key"
  ON "Sale"("tenantId", "jobId")
  WHERE "jobId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Sale_jobId_idx" ON "Sale"("jobId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Sale_jobId_fkey'
  ) THEN
    ALTER TABLE "Sale"
      ADD CONSTRAINT "Sale_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
