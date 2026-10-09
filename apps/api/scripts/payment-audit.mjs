#!/usr/bin/env node
/**
 * Payment-account AUDIT (read-only, observation only — not reconciliation).
 *
 * Shows every money movement in/out of payment accounts, one row per
 * movement, with the account attached and the source document behind it.
 * Runs each entity separately (VA and VP are never combined).
 *
 *   npm run audit:payments                          # VA + VP, Aug–Oct 2026
 *   npm run audit:payments -- --tenant VA
 *   npm run audit:payments -- --from 2026-08-01 --to 2026-10-31
 *   npm run audit:payments -- --flags-only
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const TENANT_CODES = (option('--tenant') ?? 'VA,VP')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const FROM = new Date(`${option('--from') ?? '2026-08-01'}T00:00:00.000Z`);
const TO = new Date(`${option('--to') ?? '2026-10-31'}T23:59:59.999Z`);
const FLAGS_ONLY = args.includes('--flags-only');

const prisma = new PrismaClient();
const num = (v) => Number(v ?? 0);
const money = (v) => num(v).toLocaleString('en-NG', { maximumFractionDigits: 0 });
const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '—');

const flags = [];

function section(title) {
  console.log(`\n${'='.repeat(100)}\n${title}\n${'='.repeat(100)}`);
}

function flag(entity, code, amount, detail) {
  flags.push({ entity, code, amount: num(amount), detail });
  if (!FLAGS_ONLY) console.log(`   ✗ [${code}] ${detail}`);
}

function shortName(name, len = 26) {
  const n = name ?? '—';
  return n.length > len ? `${n.slice(0, len - 1)}…` : n;
}

async function auditEntity(tenant) {
  section(`${tenant.code} — ${tenant.name}   (${d(FROM)} → ${d(TO)})`);

  const accounts = await prisma.paymentAccount.findMany({
    where: { tenantId: tenant.id, deletedAt: null },
    select: { id: true, name: true, isClosed: true },
  });
  const acctName = new Map(accounts.map((a) => [a.id, a.name]));

  const txns = await prisma.accountTransaction.findMany({
    where: {
      tenantId: tenant.id,
      deletedAt: null,
      operationDate: { gte: FROM, lte: TO },
    },
    orderBy: [{ operationDate: 'asc' }, { createdAt: 'asc' }],
  });

  const payments = await prisma.payment.findMany({
    where: {
      tenantId: tenant.id,
      deletedAt: null,
      OR: [
        { paidOn: { gte: FROM, lte: TO } },
        { paidOn: null, createdAt: { gte: FROM, lte: TO } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });
  const paymentById = new Map(payments.map((p) => [p.id, p]));

  // Reference lookups for source labelling.
  const sales = await prisma.sale.findMany({
    where: { tenantId: tenant.id, deletedAt: null },
    select: { id: true, reference: true },
  });
  const saleRef = new Map(sales.map((s) => [s.id, s.reference]));
  const movements = await prisma.stockMovement.findMany({
    where: { tenantId: tenant.id, deletedAt: null, type: 'inbound' },
    select: { id: true, reference: true },
  });
  const movementRef = new Map(movements.map((m) => [m.id, m.reference]));
  const expenses = await prisma.expense.findMany({
    where: { tenantId: tenant.id, deletedAt: null },
    select: { id: true, refNo: true, note: true },
  });
  const expenseRef = new Map(expenses.map((e) => [e.id, e.refNo ?? e.id]));

  // ---- Money movements (one row per account transaction) ----
  if (!FLAGS_ONLY) {
  console.log(`\nMONEY IN / OUT OF PAYMENT ACCOUNTS (${txns.length} movements)\n`);
  console.log(
    '   date       | account                     | dir    | amount       | subtype            | source / reference',
  );
  console.log('   ' + '-'.repeat(120));
  }
  let totalIn = 0;
  let totalOut = 0;
  for (const t of txns) {
    const payment = t.paymentId ? paymentById.get(t.paymentId) : null;
    const dir = t.type === 'credit' ? 'IN ' : 'OUT';
    if (t.type === 'credit') totalIn += num(t.amount);
    else totalOut += num(t.amount);

    // Resolve the source document behind this movement.
    let source = t.subType ?? t.note ?? '—';
    if (t.saleId) source = `sale ${saleRef.get(t.saleId) ?? t.saleId}`;
    else if (t.expenseId) source = `expense ${expenseRef.get(t.expenseId) ?? t.expenseId}`;
    else if (payment?.paymentFor === 'purchase') {
      source = `purchase ${payment.paymentRefNo ?? t.refNo ?? '—'}`;
    } else if (payment?.paymentFor === 'sale') {
      source = `sale pay ${payment.paymentRefNo ?? t.refNo ?? '—'}`;
    } else if (payment?.saleId) {
      source = `sale ${saleRef.get(payment.saleId) ?? payment.saleId}`;
    } else if (t.refNo && movementRef.size) {
      const hit = [...movementRef.values()].find((r) => r === t.refNo);
      if (hit) source = `purchase ${hit}`;
    }
    if (t.subType === 'opening_balance') source = 'opening balance';
    if (t.subType === 'transfer') source = `transfer ${t.note ?? ''}`.trim();

    if (!FLAGS_ONLY) {
      console.log(
        `   ${d(t.operationDate)} | ${shortName(acctName.get(t.accountId), 27).padEnd(27)} | ${dir}    | ${money(t.amount).padStart(12)} | ${shortName(t.subType ?? '—', 18).padEnd(18)} | ${source}`,
      );
    }

    // Audit flags (observations, not verdicts).
    if (payment && payment.accountId && payment.accountId !== t.accountId) {
      flag(
        tenant.code,
        'ACCOUNT_MISMATCH',
        t.amount,
        `${d(t.operationDate)} txn ${money(t.amount)} paid to "${acctName.get(t.accountId)}" but payment routed to "${acctName.get(payment.accountId) ?? payment.accountId}"`,
      );
    }
    if (!payment && !t.saleId && !t.expenseId && t.subType !== 'opening_balance' && t.subType !== 'transfer' && t.subType !== 'deposit') {
      flag(
        tenant.code,
        'ORPHAN_TXN',
        t.amount,
        `${d(t.operationDate)} ${dir} ${money(t.amount)} in "${acctName.get(t.accountId)}" has no linked payment/document (subtype=${t.subType ?? '—'})`,
      );
    }
  }

  if (!FLAGS_ONLY) {
    console.log('   ' + '-'.repeat(120));
    console.log(`   TOTAL IN:  ₦${money(totalIn)}`);
    console.log(`   TOTAL OUT: ₦${money(totalOut)}`);
    console.log(`   NET:       ₦${money(totalIn - totalOut)}`);
  }

  // ---- Payments in window with no money leg / no account ----
  if (!FLAGS_ONLY) {
  console.log(`\nPAYMENTS (${payments.length} in window) — account attachment check\n`);
  console.log(
    '   date       | direction | amount       | method        | account                     | source',
  );
  console.log('   ' + '-'.repeat(120));
  }
  const txnByPayment = new Map();
  for (const t of txns) {
    if (!t.paymentId) continue;
    if (!txnByPayment.has(t.paymentId)) txnByPayment.set(t.paymentId, []);
    txnByPayment.get(t.paymentId).push(t);
  }

  for (const p of payments) {
    const acct = p.accountId ? acctName.get(p.accountId) : null;
    const isPurchase = p.paymentFor === 'purchase';
    const dir = isPurchase ? 'OUT' : 'IN ';
    const src = isPurchase
      ? `purchase ${p.paymentRefNo ?? '—'}`
      : p.saleId
        ? `sale ${saleRef.get(p.saleId) ?? p.saleId}`
        : (p.paymentFor ?? '—');
    if (!FLAGS_ONLY) {
      console.log(
        `   ${d(p.paidOn ?? p.createdAt)} | ${dir}       | ${money(p.amount).padStart(12)} | ${shortName(p.method ?? '—', 13).padEnd(13)} | ${shortName(acct ?? '⚠ NONE', 27).padEnd(27)} | ${src}`,
      );
    }

    if (!p.accountId) {
      flag(tenant.code, 'NO_ACCOUNT', p.amount, `${d(p.paidOn ?? p.createdAt)} payment ₦${money(p.amount)} (${p.paymentFor ?? '—'} ${p.paymentRefNo ?? p.saleId ?? ''}) has no payment account`);
    } else if (!txnByPayment.has(p.id)) {
      flag(tenant.code, 'NO_TILL_LEG', p.amount, `${d(p.paidOn ?? p.createdAt)} payment ₦${money(p.amount)} (${p.paymentFor ?? '—'} ${p.paymentRefNo ?? p.saleId ?? ''}) has account "${acct}" but no account transaction`);
    }
  }
}

async function main() {
  console.log(`\nPAYMENT-ACCOUNT AUDIT — read-only`);
  console.log(`tenants: ${TENANT_CODES.join(', ')} | period: ${d(FROM)} → ${d(TO)}`);

  const tenants = await prisma.tenant.findMany({
    where: { code: { in: TENANT_CODES }, deletedAt: null },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
  const missing = TENANT_CODES.filter((c) => !tenants.some((t) => t.code === c));
  if (missing.length) console.log(`  ! unknown tenant codes: ${missing.join(', ')}`);

  for (const t of tenants) await auditEntity(t);

  section('FLAG SUMMARY (by entity)');
  if (!flags.length) {
    console.log('   no flags — every sampled movement had an account and a source.');
  } else {
    for (const code of TENANT_CODES) {
      const rows = flags.filter((f) => f.entity === code);
      if (!rows.length) continue;
      const byType = {};
      for (const r of rows) {
        const b = (byType[r.code] ??= { count: 0, amount: 0 });
        b.count += 1;
        b.amount += r.amount;
      }
      console.log(`\n   ${code}:`);
      for (const [k, v] of Object.entries(byType)) {
        console.log(`     ${k.padEnd(18)} count=${String(v.count).padStart(4)}   ₦${money(v.amount)}`);
      }
    }
    console.log('\n   (audit observations only — nothing here is auto-corrected.)');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
