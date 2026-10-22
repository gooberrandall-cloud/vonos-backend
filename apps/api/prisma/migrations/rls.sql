-- Row-level security policies for tenant isolation (defense-in-depth)

ALTER TABLE IF EXISTS items ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_items ON items
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR current_setting('app.tenant_id', true) = ''
  );

CREATE POLICY tenant_isolation_jobs ON jobs
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR current_setting('app.tenant_id', true) = ''
  );

CREATE POLICY tenant_isolation_ledger ON ledger_entries
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR current_setting('app.tenant_id', true) = ''
  );

CREATE POLICY tenant_isolation_suppliers ON suppliers
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR current_setting('app.tenant_id', true) = ''
  );

CREATE POLICY tenant_isolation_movements ON stock_movements
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR current_setting('app.tenant_id', true) = ''
  );
