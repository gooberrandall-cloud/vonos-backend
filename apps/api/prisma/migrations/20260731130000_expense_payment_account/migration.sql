-- Expense payment account + ledger link for expense debits
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "AccountTransaction" ADD COLUMN IF NOT EXISTS "expenseId" TEXT;

CREATE INDEX IF NOT EXISTS "Expense_accountId_idx" ON "Expense"("accountId");
CREATE INDEX IF NOT EXISTS "AccountTransaction_expenseId_idx" ON "AccountTransaction"("expenseId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Expense_accountId_fkey'
  ) THEN
    ALTER TABLE "Expense"
      ADD CONSTRAINT "Expense_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "PaymentAccount"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
