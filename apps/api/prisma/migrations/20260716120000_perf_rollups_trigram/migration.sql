-- Customer financial rollups, daily finance rollup table, and trigram search indexes.

ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "totalSell" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalSellDue" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalSellPaid" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalSellReturn" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalAdvance" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "visitCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "Customer_tenantId_totalSellDue_idx"
  ON "Customer" ("tenantId", "totalSellDue");

CREATE TABLE IF NOT EXISTS "TenantDailyFinance" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "revenue" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "costs" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "expenses" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "net" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TenantDailyFinance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantDailyFinance_tenantId_date_key"
  ON "TenantDailyFinance" ("tenantId", "date");

CREATE INDEX IF NOT EXISTS "TenantDailyFinance_tenantId_date_idx"
  ON "TenantDailyFinance" ("tenantId", "date");

ALTER TABLE "TenantDailyFinance"
  ADD CONSTRAINT "TenantDailyFinance_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Item_name_trgm_idx"
  ON "Item" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Item_sku_trgm_idx"
  ON "Item" USING gin ("sku" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Customer_name_trgm_idx"
  ON "Customer" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Customer_phone_trgm_idx"
  ON "Customer" USING gin ("phone" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Customer_email_trgm_idx"
  ON "Customer" USING gin ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Sale_reference_trgm_idx"
  ON "Sale" USING gin ("reference" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Supplier_name_trgm_idx"
  ON "Supplier" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "LedgerEntry_description_trgm_idx"
  ON "LedgerEntry" USING gin ("description" gin_trgm_ops);

-- Backfill customer rollups from existing sales/payments.
UPDATE "Customer" c
SET
  "totalSell" = COALESCE(agg."totalSell", 0),
  "totalSellDue" = COALESCE(agg."totalSellDue", 0),
  "totalSellPaid" = COALESCE(agg."totalSellPaid", 0),
  "totalSellReturn" = COALESCE(agg."totalSellReturn", 0),
  "totalAdvance" = COALESCE(agg."totalAdvance", 0),
  "visitCount" = COALESCE(agg."visitCount", 0)
FROM (
  SELECT
    s."customerId" AS "customerId",
    SUM(
      CASE
        WHEN s.status IN ('refunded', 'partially_refunded', 'written_off') THEN 0
        ELSE s.total
      END
    ) AS "totalSell",
    SUM(
      CASE
        WHEN s.status IN ('refunded', 'partially_refunded', 'written_off') THEN 0
        WHEN s."paymentStatus" IN ('due', 'partial') THEN GREATEST(
          s.total - COALESCE(p.paid, 0),
          0
        )
        ELSE 0
      END
    ) AS "totalSellDue",
    SUM(COALESCE(p.paid, 0)) AS "totalSellPaid",
    SUM(
      CASE
        WHEN s.status IN ('refunded', 'partially_refunded', 'written_off') THEN s.total
        ELSE 0
      END
    ) AS "totalSellReturn",
    GREATEST(
      SUM(COALESCE(p.paid, 0)) - SUM(
        CASE
          WHEN s.status IN ('refunded', 'partially_refunded', 'written_off') THEN 0
          ELSE s.total
        END
      ),
      0
    ) AS "totalAdvance",
    COUNT(*) FILTER (
      WHERE s.status NOT IN ('refunded', 'partially_refunded', 'written_off')
    ) AS "visitCount"
  FROM "Sale" s
  LEFT JOIN (
    SELECT "saleId", SUM(amount) AS paid
    FROM "Payment"
    WHERE "deletedAt" IS NULL
    GROUP BY "saleId"
  ) p ON p."saleId" = s.id
  WHERE s."deletedAt" IS NULL
    AND s."customerId" IS NOT NULL
  GROUP BY s."customerId"
) agg
WHERE c.id = agg."customerId";

-- Backfill daily finance rollup from ledger entries.
INSERT INTO "TenantDailyFinance" (
  "id",
  "tenantId",
  "date",
  "revenue",
  "costs",
  "expenses",
  "net",
  "currency",
  "updatedAt"
)
SELECT
  md5(le."tenantId" || ':' || le.day::text) AS id,
  le."tenantId",
  le.day,
  COALESCE(SUM(CASE WHEN le.type = 'revenue' THEN le.amount ELSE 0 END), 0) AS revenue,
  COALESCE(SUM(CASE WHEN le.type = 'cost' THEN le.amount ELSE 0 END), 0) AS costs,
  COALESCE(SUM(CASE WHEN le.type = 'expense' THEN le.amount ELSE 0 END), 0) AS expenses,
  COALESCE(SUM(
    CASE
      WHEN le.type = 'revenue' THEN le.amount
      WHEN le.type IN ('cost', 'expense') THEN -le.amount
      ELSE 0
    END
  ), 0) AS net,
  COALESCE(MAX(le.currency), 'NGN') AS currency,
  NOW() AS "updatedAt"
FROM (
  SELECT
    "tenantId",
    type,
    amount,
    currency,
    date::date AS day
  FROM "LedgerEntry"
  WHERE "deletedAt" IS NULL
) le
GROUP BY le."tenantId", le.day
ON CONFLICT ("tenantId", "date") DO UPDATE
SET
  revenue = EXCLUDED.revenue,
  costs = EXCLUDED.costs,
  expenses = EXCLUDED.expenses,
  net = EXCLUDED.net,
  currency = EXCLUDED.currency,
  "updatedAt" = EXCLUDED."updatedAt";
