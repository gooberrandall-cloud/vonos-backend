#!/usr/bin/env node
/**
 * Soft-delete test data from the books (VA). Idempotent, dry-run by default.
 *
 *   npm run audit:cleanup-test -- --dry-run
 *   npm run audit:cleanup-test -- --apply
 *
 * Removes:
 *   A. payments with amount <= 1 (test payments) + their account txns
 *   B. sales with reference starting "TIME-" (test sales) + ledger/payments/txns/movements
 *   C. ecommerce test orders VON-30431 / VON-42291 + linked sale rows, and
 *      marks the store order cancelled
 * Reverses the daily finance rollup for every revenue/cost/expense row removed.
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;
const prisma = new PrismaClient();
const num = (v) => Number(v ?? 0);
const money = (v) => num(v).toLocaleString('en-NG', { maximumFractionDigits: 0 });

const STORE_TEST_ORDERS = ['VON-30431', 'VON-42291'];
const TIME_PREFIX = 'TIME-';

function dayStart(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function rollupReverse(tenantId, date, type, amount, currency) {
  if (DRY) return;
  const day = dayStart(date);
  const isRev = type === 'revenue';
  const isCost = type === 'cost';
  // Reverse: subtract from the same bucket, add back to net.
  await prisma.tenantDailyFinance.upsert({
    where: { tenantId_date: { tenantId, date: day } },
    create: {
      id: `${tenantId}:${day.toISOString().slice(0, 10)}`,
      tenantId,
      date: day,
      revenue: isRev ? -amount : 0,
      costs: isCost ? -amount : 0,
      expenses: type === 'expense' ? -amount : 0,
      net: isRev ? -amount : amount,
      currency: currency ?? 'NGN',
    },
    update: {
      revenue: isRev ? { increment: -amount } : undefined,
      costs: isCost ? { increment: -amount } : undefined,
      expenses: type === 'expense' ? { increment: -amount } : undefined,
      net: { increment: isRev ? -amount : amount },
    },
  });
}

async function collectSaleCascade(saleIds, label) {
  const ledger = await prisma.ledgerEntry.findMany({ where: { deletedAt: null, linkedRecordType: 'sale', linkedRecordId: { in: saleIds } } });
  const payments = await prisma.payment.findMany({ where: { deletedAt: null, saleId: { in: saleIds } } });
  const paymentIds = payments.map((p) => p.id);
  const txns = await prisma.accountTransaction.findMany({
    where: { deletedAt: null, OR: [{ saleId: { in: saleIds } }, ...(paymentIds.length ? [{ paymentId: { in: paymentIds } }] : [])] },
  });
  const movements = [];
  for (const sid of saleIds) {
    const m = await prisma.stockMovement.findMany({ where: { deletedAt: null, type: 'outbound', notes: { contains: sid } } });
    movements.push(...m);
  }
  console.log(`  [${label}] sales=${saleIds.length} ledger=${ledger.length} payments=${payments.length} txns=${txns.length} movements=${movements.length}`);
  return { ledger, payments, txns, movements };
}

async function main() {
  console.log(`TEST-DATA CLEANUP (${APPLY ? 'APPLY' : 'dry-run'})`);
  const va = await prisma.tenant.findUnique({ where: { code: 'VA' }, select: { id: true } });
  const t = va.id;

  // A. Test payments
  const testPayments = await prisma.payment.findMany({ where: { tenantId: t, deletedAt: null, amount: { lte: 1 } }, select: { id: true, amount: true, paymentRefNo: true, saleId: true } });
  const testPayTxnIds = (await prisma.accountTransaction.findMany({ where: { deletedAt: null, paymentId: { in: testPayments.map((p) => p.id) } }, select: { id: true } })).map((x) => x.id);
  console.log(`\nA. test payments: ${testPayments.length}  (account txns: ${testPayTxnIds.length})`);
  for (const p of testPayments) console.log(`   ${p.id} ₦${money(p.amount)} ref=${p.paymentRefNo ?? '—'}`);

  // B. TIME- test sales
  const timeSales = await prisma.sale.findMany({ where: { tenantId: t, deletedAt: null, reference: { startsWith: TIME_PREFIX } }, select: { id: true, reference: true, total: true } });
  console.log(`\nB. TIME- test sales: ${timeSales.length}`);
  const bCascade = timeSales.length ? await collectSaleCascade(timeSales.map((s) => s.id), 'TIME-') : { ledger: [], payments: [], txns: [], movements: [] };

  // C. store test orders
  console.log(`\nC. store test orders: ${STORE_TEST_ORDERS.join(', ')}`);
  const orders = await prisma.storeOrder.findMany({ where: { reference: { in: STORE_TEST_ORDERS } }, select: { id: true, reference: true, status: true, total: true } });
  const links = await prisma.storeOrderSale.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, select: { saleId: true } });
  const storeSaleIds = links.map((l) => l.saleId);
  const cCascade = storeSaleIds.length ? await collectSaleCascade(storeSaleIds, 'store') : { ledger: [], payments: [], txns: [], movements: [] };

  if (DRY) {
    console.log(`\nDRY RUN — re-run with --apply to write.`);
    return;
  }

  const now = new Date();
  const del = { deletedAt: now };

  // A
  if (testPayments.length) await prisma.payment.updateMany({ where: { id: { in: testPayments.map((p) => p.id) } }, data: del });
  if (testPayTxnIds.length) await prisma.accountTransaction.updateMany({ where: { id: { in: testPayTxnIds } }, data: del });

  // B + C cascades (same shape)
  for (const [saleIds, cascade] of [[timeSales.map((s) => s.id), bCascade], [storeSaleIds, cCascade]]) {
    if (!saleIds.length) continue;
    for (const le of cascade.ledger) await rollupReverse(t, le.date, le.type, num(le.amount), le.currency);
    await prisma.ledgerEntry.updateMany({ where: { id: { in: cascade.ledger.map((x) => x.id) } }, data: del });
    await prisma.accountTransaction.updateMany({ where: { id: { in: cascade.txns.map((x) => x.id) } }, data: del });
    await prisma.payment.updateMany({ where: { id: { in: cascade.payments.map((x) => x.id) } }, data: del });
    await prisma.stockMovement.updateMany({ where: { id: { in: cascade.movements.map((x) => x.id) } }, data: del });
    await prisma.sale.updateMany({ where: { id: { in: saleIds } }, data: del });
  }

  // C. mark orders cancelled
  if (orders.length) await prisma.storeOrder.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { status: 'cancelled' } });

  console.log(`\nAPPLIED: ${testPayments.length} test payments, ${timeSales.length} TIME- sales, ${storeSaleIds.length} store sales soft-deleted; ${orders.length} store orders cancelled.`);
  await prisma.$disconnect();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
