-- List perf: denormalized line rollups + soft-delete-friendly indexes.
-- Avoids jsonb_array_elements on every purchases page and speeds COUNT(*).

ALTER TABLE "StockMovement"
  ADD COLUMN IF NOT EXISTS "itemCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "grandTotal" DECIMAL(65, 30) NOT NULL DEFAULT 0;

UPDATE "StockMovement"
SET
  "itemCount" = COALESCE(jsonb_array_length(lines::jsonb), 0),
  "grandTotal" = COALESCE((
    SELECT SUM(
      COALESCE((e->>'quantity')::numeric, 0) *
      COALESCE((e->>'unitCost')::numeric, 0)
    )
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(lines::jsonb) = 'array' THEN lines::jsonb
        ELSE '[]'::jsonb
      END
    ) AS e
  ), 0);

CREATE INDEX IF NOT EXISTS "StockMovement_tenantId_type_deletedAt_idx"
  ON "StockMovement" ("tenantId", "type", "deletedAt");

CREATE INDEX IF NOT EXISTS "StockMovement_tenantId_type_deletedAt_date_idx"
  ON "StockMovement" ("tenantId", "type", "deletedAt", "date");

-- Index-only COUNT for active inbound/outbound lists.
CREATE INDEX IF NOT EXISTS "StockMovement_tenantId_type_active_idx"
  ON "StockMovement" ("tenantId", "type")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "StockMovement_tenantId_type_date_active_idx"
  ON "StockMovement" ("tenantId", "type", "date" DESC)
  WHERE "deletedAt" IS NULL;
