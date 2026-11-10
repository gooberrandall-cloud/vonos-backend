-- Tax on bills: per-line VAT % on sale lines + order-level purchase tax amount.

ALTER TABLE "SaleLine"
  ADD COLUMN IF NOT EXISTS "taxPercent" DECIMAL(65,30) NOT NULL DEFAULT 0;

ALTER TABLE "StockMovement"
  ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(65,30) NOT NULL DEFAULT 0;
