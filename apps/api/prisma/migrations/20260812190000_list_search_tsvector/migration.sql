-- Hybrid list search: generated tsvector for multi-word Item / Customer typedown.
-- Keep pg_trgm for single-token / substring / SKU / phone paths (app router).

ALTER TABLE "Item"
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(sku, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("carModel", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(category, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS "Item_searchVector_gin_idx"
  ON "Item" USING GIN ("searchVector");

ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(email, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(phone, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS "Customer_searchVector_gin_idx"
  ON "Customer" USING GIN ("searchVector");
