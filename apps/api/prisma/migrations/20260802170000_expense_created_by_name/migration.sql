-- Denormalized creator name on expenses (matches Sale/StockMovement pattern).
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "createdByName" TEXT;

-- Backfill from User where createdById is set.
UPDATE "Expense" e
SET "createdByName" = u.name
FROM "User" u
WHERE e."createdById" = u.id
  AND (e."createdByName" IS NULL OR e."createdByName" = '');
