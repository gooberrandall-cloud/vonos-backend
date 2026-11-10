#!/usr/bin/env node
/**
 * Profit & payment-linkage AUDIT (read-only). Per entity (VA/VP separate).
 *
 * Part A — payments: classify TEST (amount <= 1 / test markers), MIGRATED
 *          (id starts mig_), ORGANIC (created in the app).
 * Part B — sales vs purchases: for every sale, cost its lines from the
 *          actual inbound purchase unit costs, then show revenue / COGS /
 *          gross profit per sale, and which parts sold had no purchase.
 *
 *   npm run audit:profit -- [--tenant VA,VP] [--from 2026-08-01 --to 2026-10-31]
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const option = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const CODES = (option('--tenant') ?? 'VA,VP').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const FROM = new Date(`${option('--from') ?? '2026-08-01'}T00:00:00.000Z`);
const TO = new Date(`${option('--to') ?? '2026-10-31'}T23:59:59.999Z`);
const TOP = 15;

const prisma = new PrismaClient();
const num = (v) => Number(v ?? 0);
const money = (v) => num(v).toLocaleString('en-NG', { maximumFractionDigits: 0 });
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '—');
const TEST_RE = /test|e2e|demo|dummy|sample|asdf|xxx|playwright|cypress/i;
const section = (t) => console.log(`\n${'='.repeat(100)}\n${t}\n${'='.repeat(100)}`);

async function auditEntity(t) {
  section(`${t.code} — ${t.name}   (${d(FROM)} → ${d(TO)})`);

  // ---------- Part A: payments ----------
  const payments = await prisma.payment.findMany({
    where: { tenantId: t.id, deletedAt: null },
    select: { id: true, amount: true, method: true, paymentRefNo: true, note: true, createdByName: true, paymentFor: true, paidOn: true, createdAt: true },
  });
  const cls = { test: [], migrated: [], organic: [] };
  for (const p of payments) {
    const hay = [p.method, p.paymentRefNo, p.note, p.createdByName].filter(Boolean).join(' ');
    if (num(p.amount) <= 1 || TEST_RE.test(hay)) cls.test.push(p);
    else if (p.id.startsWith('mig_')) cls.migrated.push(p);
    else cls.organic.push(p);
  }
  const sum = (rows) => rows.reduce((s, p) => s + num(p.amount), 0);
  console.log(`\nPAYMENTS (${payments.length} total)`);
  console.log(`   ORGANIC  : ${String(cls.organic.length).padStart(4)}  ₦${money(sum(cls.organic))}`);
  console.log(`   MIGRATED : ${String(cls.migrated.length).padStart(4)}  ₦${money(sum(cls.migrated))}`);
  console.log(`   TEST     : ${String(cls.test.length).padStart(4)}  ₦${money(sum(cls.test))}`);
  if (cls.test.length) {
    console.log('   test payments:');
    for (const p of cls.test) {
      console.log(`     ${d(p.paidOn ?? p.createdAt)} ₦${money(p.amount)} ${p.method ?? '—'} ref=${p.paymentRefNo ?? '—'} by=${p.createdByName ?? '—'} for=${p.paymentFor ?? '—'}`);
    }
  }

  // ---------- Part B: sales vs purchases ----------
  // Purchase cost per item, from inbound Received movements (all history so
  // pre-window purchases still cost window sales).
  const movements = await prisma.stockMovement.findMany({
    where: { tenantId: t.id, deletedAt: null, type: 'inbound', status: 'Received' },
    select: { id: true, reference: true, date: true, lines: true },
    orderBy: { date: 'asc' },
  });
  const itemCost = new Map(); // key: itemId || sku  -> { qty, value, lastUnit }
  for (const m of movements) {
    const lines = Array.isArray(m.lines) ? m.lines : [];
    for (const l of lines) {
      const key = l.itemId || l.sku;
      if (!key) continue;
      const unit = num(l.unitCost);
      const qty = num(l.quantity);
      const cur = itemCost.get(key) ?? { qty: 0, value: 0, lastUnit: 0 };
      cur.qty += qty;
      cur.value += unit * qty;
      if (unit > 0) cur.lastUnit = unit;
      itemCost.set(key, cur);
    }
  }

  const items = await prisma.item.findMany({
    where: { tenantId: t.id, deletedAt: null },
    select: { id: true, sku: true, name: true, costPrice: true },
  });
  const itemBySku = new Map(items.map((i) => [i.sku, i]));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const costFor = (line) => {
    const lookup = (itemCost.get(line.itemId) ?? itemCost.get(line.sku));
    if (lookup && lookup.qty > 0 && lookup.value > 0) {
      return { unit: lookup.value / lookup.qty, source: 'purchase-avg' };
    }
    const item = (line.itemId && itemById.get(line.itemId)) || itemBySku.get(line.sku);
    if (item && num(item.costPrice) > 0) return { unit: num(item.costPrice), source: 'item.costPrice' };
    return { unit: 0, source: 'NONE' };
  };

  const sales = await prisma.sale.findMany({
    where: {
      tenantId: t.id,
      deletedAt: null,
      date: { gte: FROM, lte: TO },
      status: { in: ['completed', 'refunded', 'partially_refunded', 'written_off'] },
    },
    include: { lines: true },
    orderBy: { date: 'asc' },
  });

  let revenue = 0, cogs = 0, noCostLines = 0, noCostValue = 0;
  const saleRows = [];
  for (const s of sales) {
    let sCogs = 0;
    for (const l of s.lines) {
      const { unit, source } = costFor(l);
      sCogs += unit * num(l.quantity);
      if (source === 'NONE') {
        noCostLines += 1;
        noCostValue += num(l.lineTotal);
      }
    }
    const rev = num(s.total);
    revenue += rev;
    cogs += sCogs;
    saleRows.push({ reference: s.reference, date: s.date, revenue: rev, cogs: sCogs, profit: rev - sCogs });
  }

  const profit = revenue - cogs;
  console.log(`\nSALES → PURCHASE COST (COGS) LINKAGE`);
  console.log(`   finalized sales: ${sales.length}`);
  console.log(`   revenue        : ₦${money(revenue)}`);
  console.log(`   COGS (from purchases): ₦${money(cogs)}`);
  console.log(`   GROSS PROFIT   : ₦${money(profit)}   margin ${revenue ? pct(profit / revenue) : '—'}`);
  console.log(`   sale lines with NO purchase cost: ${noCostLines} (₦${money(noCostValue)} revenue)`);

  saleRows.sort((a, b) => b.profit - a.profit);
  console.log(`\n   TOP ${TOP} sales by gross profit:`);
  for (const r of saleRows.slice(0, TOP)) {
    console.log(`     ${d(r.date)} ${r.reference.padEnd(20)} rev ₦${money(r.revenue).padStart(12)} cogs ₦${money(r.cogs).padStart(12)} profit ₦${money(r.profit).padStart(12)}`);
  }
  console.log(`\n   BOTTOM ${TOP} sales by gross profit (losses first):`);
  for (const r of saleRows.slice(-TOP).reverse()) {
    console.log(`     ${d(r.date)} ${r.reference.padEnd(20)} rev ₦${money(r.revenue).padStart(12)} cogs ₦${money(r.cogs).padStart(12)} profit ₦${money(r.profit).padStart(12)}`);
  }

  // Parts sold that were never purchased (no inbound cost) — top by revenue.
  const missing = new Map();
  for (const s of sales) {
    for (const l of s.lines) {
      const { source } = costFor(l);
      if (source !== 'NONE') continue;
      const key = l.sku || l.name;
      const cur = missing.get(key) ?? { name: l.name, qty: 0, revenue: 0 };
      cur.qty += num(l.quantity);
      cur.revenue += num(l.lineTotal);
      missing.set(key, cur);
    }
  }
  const missingSorted = [...missing.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, TOP);
  if (missingSorted.length) {
    console.log(`\n   PARTS SOLD WITH NO PURCHASE COST (top ${TOP} by revenue — likely opening stock / unlinked):`);
    for (const [sku, m] of missingSorted) {
      console.log(`     ${String(sku).padEnd(28)} qty ${String(m.qty).padStart(5)}  rev ₦${money(m.revenue)}`);
    }
  }
}

async function main() {
  console.log(`\nPROFIT & PAYMENT-LINKAGE AUDIT — read-only | tenants: ${CODES.join(', ')} | ${d(FROM)} → ${d(TO)}`);
  const tenants = await prisma.tenant.findMany({
    where: { code: { in: CODES }, deletedAt: null },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
  for (const t of tenants) await auditEntity(t);
  console.log('\nAudit observations only — no writes.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
