#!/usr/bin/env node
/**
 * Read-only finance + ecommerce audit. NEVER writes — all queries are
 * findMany/groupBy/count. Safe to run against any environment.
 *
 *   npm run audit:finance                # full audit (store + finance)
 *   npm run audit:finance -- --only store
 *   npm run audit:finance -- --only finance
 *   npm run audit:finance -- --tenant <tenantId>   # scope finance checks
 *   npm run audit:finance -- --limit 50             # sample size per check
 *
 * Exit 0 = no discrepancies, 1 = findings (see output).
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const only = option('--only');
const tenantScope = option('--tenant');
const LIMIT = Math.max(1, Number(option('--limit') ?? 25));

const prisma = new PrismaClient();
const num = (v) => Number(v ?? 0);
const findings = [];

function section(title) {
  console.log(`\n== ${title} ==`);
}

function ok(label, detail = '') {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function flagFinding(code, label, rows) {
  findings.push({ code, count: rows.length });
  console.log(`  ✗ ${label} (${rows.length}${rows.length >= LIMIT ? '+' : ''})`);
  for (const row of rows.slice(0, LIMIT)) console.log(`      · ${row}`);
}

async function auditStore() {
  section('Ecommerce store orders');

  const byStatus = await prisma.storeOrder.groupBy({
    by: ['status'],
    _count: true,
  });
  for (const row of byStatus) {
    console.log(`  status=${row.status}: ${row._count}`);
  }

  // 1. Paid orders with no sale link.
  const paid = await prisma.storeOrder.findMany({
    where: { status: 'paid' },
    include: { sales: true, lines: true },
    orderBy: { paidAt: 'desc' },
    take: LIMIT,
  });
  const paidNoSale = paid.filter((o) => o.sales.length === 0);
  if (paidNoSale.length) {
    flagFinding(
      'STORE_PAID_NO_SALE',
      'paid orders with no sale created',
      paidNoSale.map(
        (o) => `${o.reference} paidAt=${o.paidAt?.toISOString()} total=${o.total}`,
      ),
    );
  } else {
    ok('every sampled paid order has linked sale(s)', `${paid.length} sampled`);
  }

  // 2. Store sales missing payments / payments missing account.
  // Ignore soft-deleted test sales/payments (e.g. removed ecommerce tests).
  const links = await prisma.storeOrderSale.findMany({
    where: { sale: { deletedAt: null } },
    include: {
      order: true,
      sale: { include: { payments: { where: { deletedAt: null } } } },
    },
    orderBy: { id: 'desc' },
    take: LIMIT,
  });
  const noPayment = links.filter((l) => l.sale.payments.length === 0);
  if (noPayment.length) {
    flagFinding(
      'STORE_SALE_NO_PAYMENT',
      'store sales with zero payment rows',
      noPayment.map(
        (l) => `order=${l.order.reference} sale=${l.sale.reference} total=${l.sale.total}`,
      ),
    );
  } else {
    ok('every sampled store sale has a payment row', `${links.length} sampled`);
  }
  const noAccount = links.flatMap((l) =>
    l.sale.payments
      .filter((p) => !p.accountId)
      .map(
        (p) =>
          `order=${l.order.reference} sale=${l.sale.reference} payment=${p.id} amount=${p.amount} (no till account — invisible in account book)`,
      ),
  );
  if (noAccount.length) {
    flagFinding('STORE_PAYMENT_NO_ACCOUNT', 'store payments with no till account', noAccount);
  } else {
    ok('every sampled store payment posts to a till account');
  }

  // 3. Store sales missing revenue ledger rows.
  const saleIds = links.map((l) => l.saleId);
  const ledgerRows = await prisma.ledgerEntry.findMany({
    where: { linkedRecordType: 'sale', linkedRecordId: { in: saleIds }, deletedAt: null },
  });
  const ledgered = new Set(ledgerRows.map((r) => r.linkedRecordId));
  const noLedger = links.filter((l) => !ledgered.has(l.saleId));
  if (noLedger.length) {
    flagFinding(
      'STORE_SALE_NO_LEDGER',
      'store sales with no revenue ledger row',
      noLedger.map((l) => `order=${l.order.reference} sale=${l.sale.reference} total=${l.sale.total}`),
    );
  } else {
    ok('every sampled store sale has a revenue ledger row');
  }

  // 4. Amount mismatches order vs sales vs payments vs ledger.
  const mismatches = [];
  for (const l of links) {
    const saleTotal = num(l.sale.total);
    const paid = l.sale.payments.reduce((s, p) => s + num(p.amount), 0);
    const ledger = ledgerRows
      .filter((r) => r.linkedRecordId === l.saleId)
      .reduce((s, r) => s + num(r.amount), 0);
    if (Math.abs(saleTotal - paid) > 0.01) {
      mismatches.push(`sale=${l.sale.reference}: total=${saleTotal} payments=${paid}`);
    }
    if (Math.abs(saleTotal - ledger) > 0.01) {
      mismatches.push(`sale=${l.sale.reference}: total=${saleTotal} ledger=${ledger}`);
    }
  }
  if (mismatches.length) flagFinding('STORE_AMOUNT_MISMATCH', 'amount mismatches', mismatches);
  else ok('order/sale/payment/ledger amounts agree');

  // 5. Stock: paid store sales should have an SO- outbound movement.
  const saleIdSet = new Set(saleIds);
  const movements = await prisma.stockMovement.findMany({
    where: { type: 'outbound', deletedAt: null },
    select: { reference: true, notes: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const movedSaleIds = new Set();
  for (const m of movements) {
    const match = (m.notes ?? '').match(/saleId:([A-Za-z0-9]+)/);
    if (match && saleIdSet.has(match[1])) movedSaleIds.add(match[1]);
  }
  const noMovement = links.filter((l) => !movedSaleIds.has(l.saleId));
  if (noMovement.length) {
    flagFinding(
      'STORE_SALE_NO_MOVEMENT',
      'store sales with no outbound stock movement (stock may not have moved; or STORE_DEDUCT_STOCK=0)',
      noMovement.map((l) => `order=${l.order.reference} sale=${l.sale.reference}`),
    );
  } else {
    ok('every sampled store sale has an outbound stock movement');
  }

  // 6. Stale pending orders (older than 24h, likely abandoned/test).
  const staleCutoff = new Date(Date.now() - 24 * 3600 * 1000);
  const stale = await prisma.storeOrder.count({
    where: { status: 'pending_payment', createdAt: { lt: staleCutoff } },
  });
  if (stale) console.log(`  ! ${stale} pending_payment orders older than 24h (abandoned carts / failed pay)`);
  else ok('no stale pending orders');
}

async function auditFinance() {
  section('Finance-wide reconciliation');
  const tenantWhere = tenantScope ? { tenantId: tenantScope } : {};

  // A. Completed sales with no revenue ledger.
  const sales = await prisma.sale.findMany({
    where: {
      ...tenantWhere,
      deletedAt: null,
      status: { in: ['completed', 'refunded', 'partially_refunded', 'written_off'] },
    },
    select: { id: true, tenantId: true, reference: true, total: true, status: true },
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
  });
  const revRows = await prisma.ledgerEntry.findMany({
    where: {
      ...(tenantScope ? { tenantId: tenantScope } : {}),
      linkedRecordType: 'sale',
      type: 'revenue',
      deletedAt: null,
    },
    select: { linkedRecordId: true },
  });
  const revSet = new Set(revRows.map((r) => r.linkedRecordId));
  const salesNoRev = sales.filter((s) => !revSet.has(s.id));
  if (salesNoRev.length) {
    flagFinding(
      'SALE_NO_REVENUE',
      'finalized sales with no revenue ledger row',
      salesNoRev.map((s) => `${s.tenantId} sale=${s.reference} status=${s.status} total=${s.total}`),
    );
  } else ok('sampled finalized sales all have revenue rows', `${sales.length} sampled`);

  // B. totalPaid cache vs actual payments.
  const stalePaid = [];
  for (const s of sales.slice(0, Math.min(sales.length, LIMIT))) {
    const agg = await prisma.payment.aggregate({
      where: { saleId: s.id, deletedAt: null, isReturn: false },
      _sum: { amount: true },
    });
    const actual = num(agg._sum.amount);
    const row = await prisma.sale.findUnique({
      where: { id: s.id },
      select: { totalPaid: true, reference: true },
    });
    if (Math.abs(num(row.totalPaid) - actual) > 0.01) {
      stalePaid.push(`sale=${row.reference}: cached=${row.totalPaid} actual=${actual}`);
    }
  }
  if (stalePaid.length) flagFinding('SALE_STALE_TOTAL_PAID', 'totalPaid cache disagrees with payments', stalePaid);
  else ok('totalPaid cache agrees with payment sums');

  // C. Received inbound purchases with no cost ledger.
  const inbound = await prisma.stockMovement.findMany({
    where: {
      ...tenantWhere,
      type: 'inbound',
      status: 'Received',
      deletedAt: null,
      // Opening stock / adjustments are not purchases — exclude from the
      // "received purchase needs a cost row" check.
      NOT: [
        { reference: { startsWith: 'OS/' } },
        { reference: { startsWith: 'ADJ/' } },
      ],
    },
    select: { id: true, tenantId: true, reference: true, grandTotal: true },
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
  });
  const costRows = await prisma.ledgerEntry.findMany({
    where: {
      ...(tenantScope ? { tenantId: tenantScope } : {}),
      linkedRecordType: 'stock_movement',
      type: 'cost',
      deletedAt: null,
    },
    select: { linkedRecordId: true },
  });
  const costSet = new Set(costRows.map((r) => r.linkedRecordId));
  const inboundNoCost = inbound.filter((m) => !costSet.has(m.id) && num(m.grandTotal) > 0);
  if (inboundNoCost.length) {
    flagFinding(
      'PURCHASE_NO_COST',
      'received purchases with no cost ledger row',
      inboundNoCost.map((m) => `${m.tenantId} inbound=${m.reference} total=${m.grandTotal}`),
    );
  } else ok('sampled received purchases all have cost rows', `${inbound.length} sampled`);

  // D. Expenses with no ledger row.
  const expenses = await prisma.expense.findMany({
    where: { ...tenantWhere, deletedAt: null },
    select: { id: true, tenantId: true, totalAmount: true },
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
  });
  const expLedger = await prisma.ledgerEntry.findMany({
    where: {
      ...(tenantScope ? { tenantId: tenantScope } : {}),
      linkedRecordType: 'expense',
      deletedAt: null,
    },
    select: { linkedRecordId: true },
  });
  const expSet = new Set(expLedger.map((r) => r.linkedRecordId));
  const expNoLedger = expenses.filter((e) => !expSet.has(e.id));
  if (expNoLedger.length) {
    flagFinding(
      'EXPENSE_NO_LEDGER',
      'expenses with no ledger row',
      expNoLedger.map((e) => `${e.tenantId} expense=${e.id} amount=${e.totalAmount}`),
    );
  } else ok('sampled expenses all have ledger rows', `${expenses.length} sampled`);

  // E. Duplicate revenue rows per sale (migration double-book).
  const dupes = await prisma.$queryRawUnsafe(
    `SELECT "linkedRecordId", COUNT(*) AS c FROM "LedgerEntry"
     WHERE "linkedRecordType" = 'sale' AND type = 'revenue' AND "deletedAt" IS NULL
     ${tenantScope ? `AND "tenantId" = '${tenantScope}'` : ''}
     GROUP BY "linkedRecordId" HAVING COUNT(*) > 1 LIMIT ${LIMIT}`,
  );
  if (dupes.length) {
    flagFinding(
      'DUPLICATE_REVENUE',
      'sales with more than one revenue row',
      dupes.map((d) => `sale=${d.linkedRecordId} rows=${d.c}`),
    );
  } else ok('no duplicate revenue rows');

  // F. Cash-book payment categories that should not exist.
  const cashBook = await prisma.ledgerEntry.count({
    where: {
      ...tenantWhere,
      category: { in: ['Customer Payment', 'Supplier Payment'] },
      deletedAt: null,
    },
  });
  if (cashBook) console.log(`  ! ${cashBook} ledger rows in excluded cash-book categories (hidden from P&L by design)`);
  else ok('no cash-book category ledger rows');

  // G. Negative on-hand quantities.
  const negative = await prisma.item.count({
    where: { ...tenantWhere, quantity: { lt: 0 }, deletedAt: null },
  });
  if (negative) console.log(`  ! ${negative} items with negative quantity on hand`);
  else ok('no negative stock quantities');

  // G2. Purchase payments: totalPaid cache vs actual + missing tills.
  // Purchase payments link by paymentRefNo = purchase reference (see
  // StockMovementsService.purchasePaymentWhere) — NOT by saleId.
  const purchases = await prisma.stockMovement.findMany({
    where: {
      ...tenantWhere,
      type: 'inbound',
      deletedAt: null,
      NOT: [
        { reference: { startsWith: 'OS/' } },
        { reference: { startsWith: 'ADJ/' } },
      ],
    },
    select: { id: true, tenantId: true, reference: true, grandTotal: true, totalPaid: true, paymentStatus: true },
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
  });
  const purchasePayments = await prisma.payment.findMany({
    where: {
      ...(tenantScope ? { tenantId: tenantScope } : {}),
      paymentFor: { equals: 'purchase', mode: 'insensitive' },
      deletedAt: null,
    },
    select: { id: true, tenantId: true, amount: true, paymentRefNo: true, accountId: true },
  });
  const refKey = (s) => (s ?? '').trim().toLowerCase();
  const payByRef = new Map();
  for (const p of purchasePayments) {
    const key = refKey(p.paymentRefNo);
    if (!key) continue;
    if (!payByRef.has(key)) payByRef.set(key, []);
    payByRef.get(key).push(p);
  }
  const payProblems = [];
  for (const m of purchases) {
    const pays = payByRef.get(refKey(m.reference)) ?? [];
    const sum = pays.reduce((s, p) => s + num(p.amount), 0);
    if (Math.abs(num(m.totalPaid) - sum) > 0.01) {
      payProblems.push(
        `${m.tenantId} ${m.reference}: cached totalPaid=${m.totalPaid} actual=${sum} (${pays.length} payments)`,
      );
    }
    for (const p of pays) {
      if (!p.accountId) {
        payProblems.push(`${m.tenantId} ${m.reference}: payment ${p.id} amount=${p.amount} has no till account`);
      }
    }
    if (num(m.grandTotal) > 0 && sum > num(m.grandTotal) + 0.01) {
      payProblems.push(`${m.tenantId} ${m.reference}: overpaid total=${m.grandTotal} paid=${sum}`);
    }
  }
  if (payProblems.length) flagFinding('PURCHASE_PAYMENT', 'purchase payment problems', payProblems);
  else ok('purchase totalPaid caches agree; payments have tills', `${purchases.length} sampled`);

  // H. Orphan revenue rows (linked sale deleted/missing).
  const revLinks = await prisma.ledgerEntry.findMany({
    where: {
      ...(tenantScope ? { tenantId: tenantScope } : {}),
      linkedRecordType: 'sale',
      type: 'revenue',
      deletedAt: null,
    },
    select: { linkedRecordId: true },
    take: 500,
  });
  const saleIds = [...new Set(revLinks.map((r) => r.linkedRecordId))];
  const existing = await prisma.sale.findMany({
    where: { id: { in: saleIds } },
    select: { id: true },
  });
  const existingSet = new Set(existing.map((s) => s.id));
  const orphans = saleIds.filter((id) => !existingSet.has(id));
  if (orphans.length) {
    flagFinding('ORPHAN_REVENUE', 'revenue rows pointing at missing sales', orphans.slice(0, LIMIT).map((id) => `sale=${id}`));
  } else ok('no orphan revenue rows');
}

async function main() {
  const runStore = !only || only === 'store';
  const runFinance = !only || only === 'finance';
  if (runStore) await auditStore();
  if (runFinance) await auditFinance();

  console.log('');
  if (!findings.length) {
    console.log('AUDIT CLEAN — no discrepancies found in sampled data.');
  } else {
    const total = findings.reduce((s, f) => s + f.count, 0);
    console.log(`AUDIT FINDINGS: ${findings.length} check(s) failed, ~${total} affected row(s):`);
    for (const f of findings) console.log(`  - ${f.code}: ${f.count}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect())
  .then(() => {
    if (findings.length) process.exitCode = 1;
  });
