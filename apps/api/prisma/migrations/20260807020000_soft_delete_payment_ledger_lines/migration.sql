-- Soft-delete historical Customer/Supplier Payment P&L lines.
-- Cash remains on Payment + AccountTransaction; those ledger rows double-counted.
UPDATE "LedgerEntry"
SET "deletedAt" = NOW()
WHERE "deletedAt" IS NULL
  AND category IN ('Customer Payment', 'Supplier Payment');
