-- Business branch / POS location on operational records
ALTER TABLE "Item" ADD COLUMN "locationCode" TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "locationCode" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "locationCode" TEXT;
ALTER TABLE "Job" ADD COLUMN "locationCode" TEXT;
ALTER TABLE "Sale" ADD COLUMN "locationCode" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "locationCode" TEXT;
ALTER TABLE "Requisition" ADD COLUMN "locationCode" TEXT;

CREATE INDEX "Item_tenantId_locationCode_idx" ON "Item"("tenantId", "locationCode");
CREATE INDEX "Job_tenantId_locationCode_idx" ON "Job"("tenantId", "locationCode");
CREATE INDEX "Sale_tenantId_locationCode_idx" ON "Sale"("tenantId", "locationCode");
CREATE INDEX "StockMovement_tenantId_locationCode_idx" ON "StockMovement"("tenantId", "locationCode");
