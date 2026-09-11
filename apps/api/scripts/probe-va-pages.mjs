/**
 * Cold/warm probe for VA page APIs (Neon measure-first).
 *
 * Usage (API on :3001):
 *   node apps/api/scripts/probe-va-pages.mjs
 *
 * Optional env:
 *   API_BASE, PROBE_EMAIL, PROBE_PASSWORD, PROBE_TENANT_ID
 *   PROBE_BURST=1  — also fire each page's endpoints in parallel (browser-like)
 */
import { writeFileSync } from 'node:fs';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001';
const email = process.env.PROBE_EMAIL ?? 'admin@vag.vonos';
const password = process.env.PROBE_PASSWORD ?? 'demo123';
const tenantId = process.env.PROBE_TENANT_ID ?? 'tenant_va_001';
const doBurst = process.env.PROBE_BURST === '1';

const LIMIT = 25;

/** Primary GET for each VA surface (what the list/home page loads first). */
const PAGES = [
  {
    page: '/VA/overview',
    endpoints: [
      { name: 'hq6-home', path: '/overview/hq6-home' },
      { name: 'panel-stock-alert', path: '/overview/panels/stock-alert' },
      { name: 'panel-sales-dues', path: '/overview/panels/sales-payment-dues' },
      { name: 'panel-purchase-dues', path: '/overview/panels/purchase-payment-dues' },
    ],
  },
  {
    page: '/VA/jobs',
    endpoints: [{ name: 'jobs', path: `/jobs?limit=${LIMIT}` }],
  },
  {
    page: '/VA/vehicles',
    endpoints: [{ name: 'vehicles', path: `/vehicles?limit=${LIMIT}` }],
  },
  {
    page: '/VA/requisitions',
    endpoints: [{ name: 'requisitions', path: `/requisitions?limit=${LIMIT}` }],
  },
  {
    page: '/VA/customers',
    endpoints: [{ name: 'customers', path: `/customers?limit=${LIMIT}` }],
  },
  {
    page: '/VA/suppliers',
    endpoints: [{ name: 'suppliers', path: `/suppliers?limit=${LIMIT}` }],
  },
  {
    page: '/VA/sales',
    endpoints: [{ name: 'sales', path: `/sales?limit=${LIMIT}` }],
  },
  {
    page: '/VA/products',
    endpoints: [{ name: 'items', path: `/items?limit=${LIMIT}` }],
  },
  {
    page: '/VA/purchases',
    endpoints: [
      {
        name: 'stock-movements-inbound',
        path: `/stock-movements?type=inbound&limit=${LIMIT}`,
      },
    ],
  },
  {
    page: '/VA/expenses',
    endpoints: [{ name: 'expenses', path: `/expenses?limit=${LIMIT}` }],
  },
  {
    page: '/VA/finance',
    endpoints: [
      { name: 'ledger-summary', path: '/ledger/summary' },
      { name: 'ledger-charts', path: '/ledger/charts' },
      { name: 'ledger-list', path: `/ledger?limit=${LIMIT}` },
    ],
  },
  {
    page: '/VA/reports',
    endpoints: [{ name: 'reports-dashboard', path: '/reports/dashboard' }],
  },
  {
    page: '/VA/invoice-settings',
    endpoints: [{ name: 'invoice-settings', path: '/invoice-settings' }],
  },
  {
    page: '/VA/hrm',
    endpoints: [{ name: 'hrm-workforce', path: '/hrm/workforce' }],
  },
];

async function json(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 200) } };
  }
}

function classify(ms, status, body) {
  const msg = body?.message ?? body?.error ?? '';
  const code = body?.code ?? '';
  if (status >= 500 || String(msg).includes("Can't reach") || code === 'P1001') {
    return 'neon_unreachable';
  }
  if (String(msg).includes('Transaction') || code === 'P2028') {
    return 'tx_timeout';
  }
  if (status >= 400) return 'http_error';
  if (ms >= 5000) return 'very_slow';
  if (ms >= 2000) return 'slow';
  return 'ok';
}

async function probeOne(auth, path) {
  const t0 = Date.now();
  let status = 0;
  let body = {};
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: auth });
    ({ status, body } = await json(res));
  } catch (e) {
    status = 0;
    body = { message: e instanceof Error ? e.message : String(e) };
  }
  const ms = Date.now() - t0;
  return {
    path,
    ms,
    status,
    verdict: classify(ms, status, body),
  };
}

const loginRes = await fetch(`${API_BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const loginBody = (await json(loginRes)).body;
const token = loginBody.accessToken ?? loginBody.token;
if (!token) {
  console.error('login_failed', loginBody);
  process.exit(1);
}
console.log('login_ok=true');

const auth = {
  Authorization: `Bearer ${token}`,
  'X-Viewing-Tenant': tenantId,
};

// Flush overview caches once (list pages are mostly uncached / short TTL).
await fetch(`${API_BASE}/overview/cache/flush`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
console.log('cache_flushed=true');

const results = [];

for (const page of PAGES) {
  console.log(`\n=== ${page.page} ===`);
  const pageResult = {
    page: page.page,
    endpoints: [],
    burst: null,
  };

  for (const ep of page.endpoints) {
    const cold = await probeOne(auth, ep.path);
    const warm = await probeOne(auth, ep.path);
    const row = {
      name: ep.name,
      path: ep.path,
      coldMs: cold.ms,
      warmMs: warm.ms,
      coldStatus: cold.status,
      warmStatus: warm.status,
      coldVerdict: cold.verdict,
      warmVerdict: warm.verdict,
    };
    pageResult.endpoints.push(row);
    console.log(
      `  ${ep.name} cold=${cold.ms}ms(${cold.verdict}) warm=${warm.ms}ms(${warm.verdict}) status=${cold.status}/${warm.status}`,
    );
  }

  if (doBurst && page.endpoints.length > 1) {
    const t0 = Date.now();
    const burst = await Promise.all(
      page.endpoints.map((ep) => probeOne(auth, ep.path)),
    );
    pageResult.burst = {
      wallMs: Date.now() - t0,
      endpoints: burst.map((b) => ({
        path: b.path,
        ms: b.ms,
        status: b.status,
        verdict: b.verdict,
      })),
    };
    console.log(
      `  BURST wall=${pageResult.burst.wallMs}ms [${burst.map((b) => `${b.ms}ms/${b.verdict}`).join(', ')}]`,
    );
  }

  results.push(pageResult);
}

const metricsRes = await fetch(`${API_BASE}/overview/cache/metrics`, {
  headers: { Authorization: `Bearer ${token}` },
});
const metrics = (await json(metricsRes)).body;

const flat = results.flatMap((p) =>
  p.endpoints.map((e) => ({ page: p.page, ...e })),
);
const slow = flat
  .filter((e) => e.coldMs >= 2000 || e.coldVerdict !== 'ok')
  .sort((a, b) => b.coldMs - a.coldMs);

const report = {
  at: new Date().toISOString(),
  apiBase: API_BASE,
  tenantId,
  connectionLimit: metrics?.pool?.connectionLimit ?? null,
  pool: metrics?.pool ?? null,
  queries: metrics?.queries ?? null,
  summary: {
    endpoints: flat.length,
    coldOk: flat.filter((e) => e.coldVerdict === 'ok').length,
    coldSlow: flat.filter((e) => e.coldVerdict === 'slow').length,
    coldVerySlow: flat.filter((e) => e.coldVerdict === 'very_slow').length,
    coldErrors: flat.filter((e) =>
      ['neon_unreachable', 'tx_timeout', 'http_error'].includes(e.coldVerdict),
    ).length,
    worstCold: slow.slice(0, 8),
  },
  pages: results,
};

console.log('\n=== SUMMARY (worst cold) ===');
for (const row of slow.slice(0, 12)) {
  console.log(
    `  ${row.coldMs}ms ${row.coldVerdict} ${row.page} ${row.name}`,
  );
}

const outPath = new URL(
  '../../../docs/migration-audits/VA_PAGES_NEON_PROBE.json',
  import.meta.url,
);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nwrote ${outPath.pathname}`);
