#!/usr/bin/env node
/**
 * Precise fix for mis-dated historical payments (the two auto-stamp bugs only).
 *
 * Bug A — sale convert/finalize: payment stamped with the sale's own date,
 *   but entered on a later day (and the sale was genuinely created on its date,
 *   so legitimately back-dated sales are left alone).
 * Bug B — purchase prefill: payment stamped with a sibling payment's date on
 *   the same bill, but entered on a later day.
 *
 * Fixes both the Payment.paidOn and the linked AccountTransaction.operationDate
 * to the payment's `createdAt` (when it was actually entered).
 *
 * Dry-run by default. Apply with:
 *   node --env-file=.env scripts/fix-payment-dates-precise.mjs --execute
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--execute');
const num = (v) => Number(v ?? 0);
const money = (v) => num(v).toLocaleString('en-NG', { maximumFractionDigits: 0 });
const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '—');

const BUG_A_JOIN = `"Payment" p JOIN "Sale" s ON s.id = p."saleId"`;
const BUG_A_WHERE = `
  p."deletedAt" IS NULL AND s."deletedAt" IS NULL
  AND p."isReturn" = false
  AND p.id NOT LIKE 'mig\\_%'
  AND p."paidOn" = s."date"
  AND p."createdAt"::date > p."paidOn"::date
  AND s."createdAt"::date = s."date"::date`;

const BUG_B_WHERE = `
  p."deletedAt" IS NULL
  AND p."isReturn" = false
  AND p."paymentFor" = 'purchase'
  AND p.id NOT LIKE 'mig\\_%'
  AND p."paidOn" IS NOT NULL
  AND p."createdAt"::date > p."paidOn"::date
  AND EXISTS (
    SELECT 1 FROM "Payment" q
    WHERE q."invoiceId" = p."invoiceId"
      AND q.id <> p.id
      AND q."deletedAt" IS NULL
      AND q."paidOn" = p."paidOn"
  )`;

async function scopeA() {
  const pay = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int cnt, SUM(p.amount)::float total FROM ${BUG_A_JOIN} WHERE ${BUG_A_WHERE}`,
  );
  const txn = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int cnt FROM "AccountTransaction" a
    JOIN "Payment" p ON p.id = a."paymentId"
    JOIN "Sale" s ON s.id = p."saleId"
    WHERE a."deletedAt" IS NULL AND ${BUG_A_WHERE}`);
  return { payments: num(pay[0]?.cnt ?? 0), amount: num(pay[0]?.total ?? 0), txns: num(txn[0]?.cnt ?? 0) };
}

async function scopeB() {
  const pay = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int cnt, SUM(p.amount)::float total FROM "Payment" p WHERE ${BUG_B_WHERE}`,
  );
  const txn = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int cnt FROM "AccountTransaction" a
    JOIN "Payment" p ON p.id = a."paymentId"
    WHERE a."deletedAt" IS NULL AND ${BUG_B_WHERE}`);
  return { payments: num(pay[0]?.cnt ?? 0), amount: num(pay[0]?.total ?? 0), txns: num(txn[0]?.cnt ?? 0) };
}

const a = await scopeA();
const b = await scopeB();
console.log(`Bug A (sale convert/finalize):  ${a.payments} payments (${money(a.amount)}), ${a.txns} account txns`);
console.log(`Bug B (purchase prefill):       ${b.payments} payments (${money(b.amount)}), ${b.txns} account txns`);
console.log(`TOTAL: ${a.payments + b.payments} payments, ${a.txns + b.txns} account txns`);

// Samples for review
const samplesA = await prisma.$queryRawUnsafe(`
  SELECT s.reference, p."paidOn" AS old, p."createdAt" AS new, p.amount
  FROM ${BUG_A_JOIN} WHERE ${BUG_A_WHERE}
  ORDER BY p."createdAt" DESC LIMIT 5`);
const samplesB = await prisma.$queryRawUnsafe(`
  SELECT i.reference, p."paidOn" AS old, p."createdAt" AS new, p.amount
  FROM "Payment" p LEFT JOIN "Invoice" i ON i.id = p."invoiceId"
  WHERE ${BUG_B_WHERE} ORDER BY p."createdAt" DESC LIMIT 5`);
console.log('\nBug A sample (ref | old → new | amount):');
for (const r of samplesA) console.log(`  ${r.reference} | ${d(r.old)} → ${d(r.new)} | ${money(r.amount)}`);
console.log('Bug B sample:');
for (const r of samplesB) console.log(`  ${r.reference ?? '—'} | ${d(r.old)} → ${d(r.new)} | ${money(r.amount)}`);

if (!APPLY) {
  console.log('\n(dry-run — no writes. re-run with --execute to apply)');
  await prisma.$disconnect();
  process.exit(0);
}

// Backup affected payment rows before mutating.
const backup = await prisma.$queryRawUnsafe(`
  SELECT p.id, p."paidOn", p."createdAt" FROM ${BUG_A_JOIN} WHERE ${BUG_A_WHERE}
  UNION ALL
  SELECT p.id, p."paidOn", p."createdAt" FROM "Payment" p WHERE ${BUG_B_WHERE}`);
writeFileSync(
  '/var/folders/r0/z4z659xs5h58f7pmgjnjch5w0000gp/T/opencode/payment-date-precise-backup.json',
  JSON.stringify({ at: new Date().toISOString(), rows: backup }, null, 2),
);
console.log(`\nbacked up ${backup.length} payment rows`);

// Order matters: account-txn updates first (while paidOn is still old).
await prisma.$transaction([
  prisma.$executeRawUnsafe(`
    UPDATE "AccountTransaction" a SET "operationDate" = p."createdAt"
    FROM "Payment" p JOIN "Sale" s ON s.id = p."saleId"
    WHERE a."paymentId" = p.id AND a."deletedAt" IS NULL AND ${BUG_A_WHERE}`),
  prisma.$executeRawUnsafe(`
    UPDATE "AccountTransaction" a SET "operationDate" = p."createdAt"
    FROM "Payment" p
    WHERE a."paymentId" = p.id AND a."deletedAt" IS NULL AND ${BUG_B_WHERE}`),
  prisma.$executeRawUnsafe(
    `UPDATE "Payment" p SET "paidOn" = p."createdAt" FROM "Sale" s WHERE p."saleId" = s.id AND ${BUG_A_WHERE}`,
  ),
  prisma.$executeRawUnsafe(
    `UPDATE "Payment" p SET "paidOn" = p."createdAt" WHERE ${BUG_B_WHERE}`,
  ),
]);

const a2 = await scopeA();
const b2 = await scopeB();
console.log('\nAFTER — remaining matches:');
console.log(`  Bug A: ${a2.payments} payments, ${a2.txns} txns`);
console.log(`  Bug B: ${b2.payments} payments, ${b2.txns} txns`);
console.log('done.');
await prisma.$disconnect();
