-- VA list perf: partial B-trees matching default list ORDER BY + deletedAt IS NULL.
-- Avoids seq-scan + top-N sort on Customer / Invoice / Item / Expense / Supplier.

CREATE INDEX IF NOT EXISTS "Customer_tenantId_name_id_active_idx"
  ON "Customer" ("tenantId", name, id)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Invoice_tenantId_documentDate_id_active_idx"
  ON "Invoice" ("tenantId", "documentDate" DESC, id DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Item_tenantId_updatedAt_id_active_idx"
  ON "Item" ("tenantId", "updatedAt" DESC, id DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Expense_tenantId_expenseDate_id_active_idx"
  ON "Expense" ("tenantId", "expenseDate" DESC, id DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Supplier_tenantId_name_id_active_idx"
  ON "Supplier" ("tenantId", name, id)
  WHERE "deletedAt" IS NULL;
