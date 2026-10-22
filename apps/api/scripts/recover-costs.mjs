#!/usr/bin/env node
/**
 * Recover item costPrice from multiple sources, in priority order:
 *   1. inline purchase lines across ALL tenants (actual unitCost)
 *   2. other tenants' item.costPrice (by SKU, then name)
 *   3. legacy Ultimate POS cost map (JSON from scripts/legacy-cost-extract.py)
 * Skips service-like names. Idempotent (only fills items at cost 0). Sanity
 * guard: never set a cost above the item's sellPrice.
 * Dry-run by default.
 *
 *   npm run audit:recover-costs -- --tenant VA [--legacy /path.json] [--apply]
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes('--apply');
const DRY = !APPLY;
const TARGET = (opt('--tenant') ?? 'VA').toUpperCase();
const LEGACY_PATH = opt('--legacy') ?? '/var/folders/r0/z4z659xs5h58f7pmgjnjch5w0000gp/T/opencode/legacy-costs.json';

const prisma = new PrismaClient();
const num = (v) => Number(v ?? 0);
const money = (v) => num(v).toLocaleString('en-NG', { maximumFractionDigits: 0 });
const norm = (s) => (s ?? '').trim().toUpperCase();

const SERVICE = /(DIAGNOS|LABOUR|LABOR|WHEEL|ALIGN|BALANC|PROGRAMMING|INJECTOR|PANEL|ACADEMY|INSTAL|SWAP|CLEAN|WASH|LOGISTIC|CALIBRAT|RETHREAD|FIXING|TINT|POLISH|SERVICE|CLEARING|PAINT|UPHOLST|VULCAN|\bFEE\b|CHARGE|TRANSPORT|DELIVERY|TO GET|DELIVER|INSPECTION|COMPRESSION TEST|RESETTING|ADJUSTMENT OF)/i;

async function main() {
  const t = await prisma.tenant.findUnique({ where: { code: TARGET }, select: { id: true, name: true } });
  if (!t) throw new Error(`tenant ${TARGET} not found`);
  console.log(`MULTI-SOURCE COST RECOVERY — ${TARGET} (${t.name})  [${APPLY ? 'APPLY' : 'dry-run'}]`);

  // 1. purchase lines across all tenants (latest unitCost wins).
  // Paginated so the Neon pooler isn't held on one giant jsonb read.
  const purchSku = new Map(), purchName = new Map();
  let cursor;
  for (;;) {
    const page = await prisma.stockMovement.findMany({
      where: { deletedAt: null, type: 'inbound' },
      select: { id: true, lines: true, date: true },
      orderBy: { id: 'asc' },
      take: 150,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    for (const m of page) for (const l of (Array.isArray(m.lines) ? m.lines : [])) {
      const u = num(l.unitCost); if (u <= 0) continue;
      if (l.sku) purchSku.set(norm(l.sku), u);
      if (l.name) purchName.set(norm(l.name), u);
    }
    if (page.length < 150) break;
    cursor = page[page.length - 1].id;
  }

  // 2. other tenants' item costPrice
  const items = await prisma.item.findMany({ where: { deletedAt: null, costPrice: { gt: 0 } }, select: { sku: true, name: true, costPrice: true } });
  const itemSku = new Map(), itemName = new Map();
  for (const i of items) {
    if (i.sku && !itemSku.has(norm(i.sku))) itemSku.set(norm(i.sku), num(i.costPrice));
    if (i.name && !itemName.has(norm(i.name))) itemName.set(norm(i.name), num(i.costPrice));
  }

  // 3. legacy
  const legSku = new Map(), legName = new Map();
  if (existsSync(LEGACY_PATH)) {
    const legacy = JSON.parse(readFileSync(LEGACY_PATH, 'utf8'));
    for (const [k, v] of Object.entries(legacy.sku_cost ?? {})) legSku.set(norm(k), num(v));
    for (const [k, v] of Object.entries(legacy.name_cost ?? {})) legName.set(norm(k), num(v));
  } else {
    console.log(`  (legacy map not found at ${LEGACY_PATH} — skipped)`);
  }

  const targets = await prisma.item.findMany({ where: { tenantId: t.id, deletedAt: null, costPrice: { lte: 0 } }, select: { id: true, sku: true, name: true, sellPrice: true } });
  const bySource = { purchase: 0, item: 0, legacy: 0 };
  let applied = 0, services = 0, none = 0, rejected = 0, total = 0;

  for (const it of targets) {
    const nm = (it.name || '').trim();
    if (SERVICE.test(nm)) { services++; continue; }
    const s = norm(it.sku), n = norm(nm);
    let cost = 0, src = '';
    if (purchSku.get(s) || purchName.get(n)) { cost = purchSku.get(s) ?? purchName.get(n); src = 'purchase'; }
    else if (itemSku.get(s) || itemName.get(n)) { cost = itemSku.get(s) ?? itemName.get(n); src = 'item'; }
    else if (legSku.get(s) || legName.get(n)) { cost = legSku.get(s) ?? legName.get(n); src = 'legacy'; }
    if (!cost || cost <= 0) { none++; continue; }
    if (num(it.sellPrice) > 0 && cost > num(it.sellPrice)) { rejected++; continue; }
    bySource[src]++; applied++; total += cost;
    if (!DRY) await prisma.item.update({ where: { id: it.id }, data: { costPrice: cost } });
  }

  console.log(`  target no-cost items : ${targets.length}`);
  console.log(`  recovered            : ${applied}  (purchase ${bySource.purchase}, item ${bySource.item}, legacy ${bySource.legacy})`);
  console.log(`  total cost values    : ₦${money(total)}`);
  console.log(`  services skipped     : ${services}`);
  console.log(`  sanity-rejected (cost>sell): ${rejected}`);
  console.log(`  no source            : ${none}`);
  console.log(DRY ? 'dry run — re-run with --apply to write.' : 'done.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
