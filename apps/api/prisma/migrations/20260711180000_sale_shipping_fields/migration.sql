-- Shipments / POS shipping fields on Sale (schema already had these; DB did not).
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "shippingStatus" TEXT;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "shippingAddress" TEXT;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "trackingNumber" TEXT;

CREATE INDEX IF NOT EXISTS "Sale_tenantId_shippingStatus_idx"
  ON "Sale"("tenantId", "shippingStatus");
