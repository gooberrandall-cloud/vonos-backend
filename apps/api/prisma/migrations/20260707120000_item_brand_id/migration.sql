-- AlterTable
ALTER TABLE "Item" ADD COLUMN "brandId" TEXT;

-- CreateIndex
CREATE INDEX "Item_tenantId_brandId_idx" ON "Item"("tenantId", "brandId");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;
