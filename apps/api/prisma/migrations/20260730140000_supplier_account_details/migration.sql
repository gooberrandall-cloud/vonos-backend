-- Supplier bank / account details (Ultimate POS contact bank fields).

ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "accountHolderName" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "bankName" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "bankBranch" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "bankCode" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "bankAccountNo" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "taxPayerId" TEXT;
