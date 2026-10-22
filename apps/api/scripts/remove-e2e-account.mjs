#!/usr/bin/env node
/**
 * Remove the leftover E2E test payment account(s) and their live rows.
 *
 * Soft-deletes (deletedAt) the account, its AccountTransactions and any
 * Payments still pointing at it. Dry-run by default:
 *   node --env-file-if-exists=.env scripts/remove-e2e-account.mjs
 * Apply with --execute (writes a JSON backup first).
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--execute');
const n = (v) => Number(v ?? 0);
const money = (v) => n(v).toLocaleString('en-NG', { maximumFractionDigits: 2 });

const accounts = await prisma.paymentAccount.findMany({
  where: { deletedAt: null, name: { contains: 'e2e', mode: 'insensitive' } },
  select: { id: true, name: true, tenantId: true, createdByName: true, tenant: { select: { code: true } } },
});

if (!accounts.length) {
  console.log('No E2E-named payment accounts found (nothing to do).');
  await prisma.$disconnect();
  process.exit(0);
}

const backup = [];
for (const account of accounts) {
  const txns = await prisma.accountTransaction.findMany({
    where: { accountId: account.id, deletedAt: null },
    select: { id: true, type: true, subType: true, amount: true, refNo: true, operationDate: true, paymentId: true, note: true, createdByName: true },
  });
  const payments = await prisma.payment.findMany({
    where: { accountId: account.id, deletedAt: null },
    select: { id: true, amount: true, method: true, paymentRefNo: true, paymentFor: true, paidOn: true, createdAt: true, createdByName: true },
  });
  console.log(`\n${account.tenant?.code} — "${account.name}" (${account.createdByName ?? '—'})`);
  console.log(`  live transactions: ${txns.length}`);
  for (const t of txns) console.log(`    ${t.operationDate.toISOString().slice(0,10)} ${t.type.padEnd(6)} ${money(t.amount).padStart(12)} ${t.subType ?? '—'} ref=${t.refNo ?? '—'} pay=${t.paymentId ? 'yes' : '—'}`);
  console.log(`  live payments: ${payments.length}`);
  for (const p of payments) console.log(`    ${(p.paidOn ?? p.createdAt).toISOString().slice(0,10)} ${money(p.amount).padStart(12)} ${p.method ?? '—'} ref=${p.paymentRefNo ?? '—'} for=${p.paymentFor ?? '—'}`);
  backup.push({ account, transactions: txns, payments });
}

if (!APPLY) {
  console.log('\n(dry-run — no writes). Re-run with --execute to remove.');
  await prisma.$disconnect();
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `/var/folders/r0/z4z659xs5h58f7pmgjnjch5w0000gp/T/opencode/e2e-account-backup-${stamp}.json`;
writeFileSync(backupPath, JSON.stringify({ at: new Date().toISOString(), rows: backup }, null, 2));
console.log(`\nbackup written: ${backupPath}`);

const now = new Date();
for (const account of accounts) {
  await prisma.$transaction([
    prisma.accountTransaction.updateMany({ where: { accountId: account.id, deletedAt: null }, data: { deletedAt: now } }),
    prisma.payment.updateMany({ where: { accountId: account.id, deletedAt: null }, data: { deletedAt: now } }),
    prisma.paymentAccount.update({ where: { id: account.id }, data: { deletedAt: now, isClosed: true } }),
  ]);
  console.log(`removed "${account.name}"`);
}
console.log('done. Note: cached lists refresh within the list TTL (~5 min) or after a cache bust.');
await prisma.$disconnect();
