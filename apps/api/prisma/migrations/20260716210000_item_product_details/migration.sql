-- Product detail fields for Ultimate POS parity (car model fitment, unit, etc.)
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "subCategory" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "barcodeType" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "unit" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "weight" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "carModel" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "enableImei" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "preparationMinutes" INTEGER;

CREATE INDEX IF NOT EXISTS "Item_tenantId_carModel_idx" ON "Item"("tenantId", "carModel");
