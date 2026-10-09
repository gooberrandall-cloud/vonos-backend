-- Employee bank / tax fields from Ultimate POS users.bank_details (payslip).

ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "accountHolderName" TEXT;
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "bankName" TEXT;
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "bankBranch" TEXT;
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "bankCode" TEXT;
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "bankAccountNo" TEXT;
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "taxPayerId" TEXT;

CREATE INDEX IF NOT EXISTS "Employee_tenantId_employeeCode_idx"
  ON "Employee"("tenantId", "employeeCode");
