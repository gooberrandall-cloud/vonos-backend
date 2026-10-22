-- B-tree indexes for O(log n) SKU / name lookup within a tenant.
-- Complements existing GIN trigram indexes used for fuzzy contains search.

CREATE INDEX IF NOT EXISTS "Item_tenantId_sku_idx"
  ON "Item" ("tenantId", "sku");

CREATE INDEX IF NOT EXISTS "Item_tenantId_name_idx"
  ON "Item" ("tenantId", "name");

-- Case-insensitive equality / prefix (ILIKE 'x%' / lower(sku) = …).
CREATE INDEX IF NOT EXISTS "Item_tenantId_lower_sku_idx"
  ON "Item" ("tenantId", lower("sku") text_pattern_ops);

CREATE INDEX IF NOT EXISTS "Item_tenantId_lower_name_idx"
  ON "Item" ("tenantId", lower("name") text_pattern_ops);
