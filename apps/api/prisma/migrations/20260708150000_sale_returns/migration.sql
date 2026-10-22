-- AlterEnum
ALTER TYPE "SaleStatus" ADD VALUE IF NOT EXISTS 'written_off';

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "originalSaleId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Sale_originalSaleId_idx" ON "Sale"("originalSaleId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Sale_originalSaleId_fkey'
  ) THEN
    ALTER TABLE "Sale"
      ADD CONSTRAINT "Sale_originalSaleId_fkey"
      FOREIGN KEY ("originalSaleId") REFERENCES "Sale"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
