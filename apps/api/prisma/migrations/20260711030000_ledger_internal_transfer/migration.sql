-- Tag ledger rows that are internal cross-entity transfers for VAG consolidation.
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "isInternalTransfer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "counterpartyTenantId" TEXT;

CREATE INDEX IF NOT EXISTS "LedgerEntry_tenantId_isInternalTransfer_idx"
  ON "LedgerEntry"("tenantId", "isInternalTransfer");
