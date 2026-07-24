/**
 * Focused cold/warm probe for customers / suppliers / sales list.
 *   node apps/api/scripts/probe-va-lists.mjs
 */
import { writeFileSync } from 'node:fs';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001';
const email = process.env.PROBE_EMAIL ?? 'admin@vag.vonos';
const password = process.env.PROBE_PASSWORD ?? 'demo123';
const tenantId = process.env.PROBE_TENANT_ID ?? 'tenant_va_001';

const ENDPOINTS = [
  { name: 'customers', path: '/customers?limit=25' },
  { name: 'customers-rows', path: '/customers?limit=25&includeSummary=0' },
  { name: 'suppliers', path: '/suppliers?limit=25' },
  { name: 'suppliers-rows', path: '/suppliers?limit=25&includeSummary=0' },
  { name: 'sales', path: '/sales?limit=25' },
  { name: 'sales-rows', path: '/sales?limit=25&includeSummary=0' },
  {
    name: 'purchases-inbound',
    path: '/stock-movements?type=inbound&limit=25',
  },
  {
    name: 'purchases-inbound-rows',
    path: '/stock-movements?type=inbound&limit=25&includeSummary=0',
  },
  { name: 'reports-dashboard', path: '/reports/dashboard' },
  { name: 'invoice-settings', path: '/invoice-settings' },
];

async function json(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 200) } };
  }
}

async function probe(auth, path) {
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}${path}`, { headers: auth });
  const { status, body } = await json(res);
  return {
    ms: Date.now() - t0,
    status,
    rows: Array.isArray(body?.items)
      ? body.items.length
      : Array.isArray(body)
        ? body.length
        : null,
    err: status >= 400 ? body?.message ?? body?.error ?? true : null,
  };
}

const login = (
  await json(
    await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  )
).body;
const token = login.accessToken ?? login.token;
if (!token) {
  console.error('login_failed', login);
  process.exit(1);
}

const auth = {
  Authorization: `Bearer ${token}`,
  'X-Viewing-Tenant': tenantId,
};

const results = [];
for (const ep of ENDPOINTS) {
  const cold = await probe(auth, ep.path);
  const warm = await probe(auth, ep.path);
  const row = { name: ep.name, path: ep.path, cold, warm };
  results.push(row);
  console.log(
    `${ep.name} cold=${cold.ms}ms status=${cold.status} rows=${cold.rows} warm=${warm.ms}ms`,
  );
}

const report = {
  at: new Date().toISOString(),
  tenantId,
  baselineColdMs: {
    customers: 21679,
    suppliers: 21597,
    sales: 12871,
  },
  results,
};

writeFileSync(
  new URL('../../../docs/migration-audits/VA_LISTS_NEON_PROBE.json', import.meta.url),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log('wrote docs/migration-audits/VA_LISTS_NEON_PROBE.json');
