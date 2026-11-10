/**
 * Measure-first probe for VA HQ6 home (plan: Overview Neon Measure First).
 *
 * Usage (API must be running on :3001):
 *   node apps/api/scripts/probe-va-overview.mjs
 *
 * Env (optional):
 *   API_BASE=http://localhost:3001
 *   PROBE_EMAIL=admin@vag.vonos
 *   PROBE_PASSWORD=demo123
 *   PROBE_TENANT_ID=tenant_va_001
 *
 * Uses X-Viewing-Tenant (required for super_admin entity views).
 * Probes GET /overview/hq6-home (what /VA/overview actually loads).
 */
import { writeFileSync } from 'node:fs';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001';
const email = process.env.PROBE_EMAIL ?? 'admin@vag.vonos';
const password = process.env.PROBE_PASSWORD ?? 'demo123';
const tenantId = process.env.PROBE_TENANT_ID ?? 'tenant_va_001';

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 400), status: res.status };
  }
}

async function timed(label, fn) {
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  console.log(`${label}_ms=${ms}`);
  return { ms, result };
}

const loginRes = await fetch(`${API_BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const loginBody = await json(loginRes);
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

await timed('flush', async () => {
  const res = await fetch(`${API_BASE}/overview/cache/flush`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return json(res);
});

const cold = await timed('cold_hq6_home', async () => {
  const res = await fetch(`${API_BASE}/overview/hq6-home`, { headers: auth });
  return json(res);
});

const metricsCold = await timed('metrics_after_cold', async () => {
  const res = await fetch(`${API_BASE}/overview/cache/metrics`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json(res);
});

const warm = await timed('warm_hq6_home', async () => {
  const res = await fetch(`${API_BASE}/overview/hq6-home`, { headers: auth });
  return json(res);
});

const metricsWarm = await timed('metrics_after_warm', async () => {
  const res = await fetch(`${API_BASE}/overview/cache/metrics`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json(res);
});

const report = {
  at: new Date().toISOString(),
  apiBase: API_BASE,
  tenantId,
  endpoint: '/overview/hq6-home',
  coldHq6HomeMs: cold.ms,
  warmHq6HomeMs: warm.ms,
  coldPayload: {
    financeKpis: cold.result?.financeKpis?.length ?? 0,
    charts: cold.result?.charts?.length ?? 0,
  },
  poolAfterCold: metricsCold.result?.pool ?? null,
  queriesAfterCold: metricsCold.result?.queries ?? null,
  poolAfterWarm: metricsWarm.result?.pool ?? null,
  queriesAfterWarm: metricsWarm.result?.queries ?? null,
  decision:
    (metricsCold.result?.queries?.wait ?? 0) > 0
      ? 'High pool wait — keep limit ~8–10; fewer concurrent Prisma calls'
      : cold.ms > 2000
        ? 'Low wait, high wall — round-trip/RTT; SQL collapse justified'
        : 'Healthy cold path under 2s',
};

console.log(JSON.stringify(report, null, 2));
writeFileSync(
  new URL('../../../docs/migration-audits/VA_OVERVIEW_NEON_PROBE.json', import.meta.url),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log('wrote docs/migration-audits/VA_OVERVIEW_NEON_PROBE.json');
