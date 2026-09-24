-- Denormalized purchase payment sum for HQ6 purchases list (avoid Payment fan-out).
ALTER TABLE "StockMovement" ADD COLUMN IF NOT EXISTS "totalPaid" DECIMAL(65,30) NOT NULL DEFAULT 0;

WITH matches AS (
  SELECT DISTINCT sm.id AS mid, p.id AS pid, p.amount
  FROM "StockMovement" sm
  LEFT JOIN "Invoice" i
    ON i."stockMovementId" = sm.id AND i."deletedAt" IS NULL
  JOIN "Payment" p
    ON p."deletedAt" IS NULL
   AND p."tenantId" = sm."tenantId"
   AND (
     (p."paymentFor" = 'purchase' AND p."paymentRefNo" = sm.reference)
     OR (i.id IS NOT NULL AND p."invoiceId" = i.id)
   )
  WHERE sm."deletedAt" IS NULL AND sm.type = 'inbound'
),
paid AS (
  SELECT mid, SUM(amount) AS paid FROM matches GROUP BY mid
)
UPDATE "StockMovement" sm
SET "totalPaid" = paid.paid
FROM paid
WHERE sm.id = paid.mid;
