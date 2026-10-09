#!/usr/bin/env node
/**
 * Backfill missing Payroll expense ledger rows for migrated payroll.
 * Matches the app's own posting (hrm.service.ts): on payment, one expense row
 * per payroll (amount = netPay, category 'Payroll', linkedRecordType 'payroll').
 * Idempotent (skips payrolls that already have a row). Dry-run by default.
 *
 *   npm run audit:payroll-backfill -- --tenant VA --dry-run
 *   npm run audit:payroll-backfill -- --tenant VA --apply
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes('--apply');
const DRY = !APPLY;
const TENANT_CODE = (opt('--tenant') ?? 'VA').toUpperCase();
/** Only post finalized payroll (status='final'); drafts excluded. Default final. */
const STATUS = opt('--status') ?? 'final';
const FROM = opt('--from') ? new Date(`${opt('--from')}T00:00:00.000Z`) : undefined;
const TO = opt('--to') ? new Date(`${opt('--to')}T23:59:59.999Z`) : undefined;
const prisma = new PrismaClient();
const num = (v) => Number(v ?? 0);
const money = (v) => num(v).toLocaleString('en-NG', { maximumFractionDigits: 0 });

function dayStart(d) { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; }

async function rollup(tenantId, date, amount, currency) {
  const day = dayStart(date);
  await prisma.tenantDailyFinance.upsert({
    where: { tenantId_date: { tenantId, date: day } },
    create: { id: `${tenantId}:${day.toISOString().slice(0, 10)}`, tenantId, date: day, revenue: 0, costs: 0, expenses: amount, net: -amount, currency: currency ?? 'NGN' },
    update: { expenses: { increment: amount }, net: { increment: -amount } },
  });
}

async function main() {
  const t = await prisma.tenant.findUnique({ where: { code: TENANT_CODE }, select: { id: true, name: true } });
  if (!t) throw new Error(`tenant ${TENANT_CODE} not found`);
  console.log(`PAYROLL BACKFILL — ${TENANT_CODE} (${t.name})  status=${STATUS}${FROM ? ` from=${FROM.toISOString().slice(0,10)}` : ''}${TO ? ` to=${TO.toISOString().slice(0,10)}` : ''}  [${APPLY ? 'APPLY' : 'dry-run'}]`);

  const paid = await prisma.payroll.findMany({
    where: {
      tenantId: t.id,
      deletedAt: null,
      status: STATUS,
      ...(FROM || TO ? { payrollMonth: { ...(FROM ? { gte: FROM } : {}), ...(TO ? { lte: TO } : {}) } } : {}),
    },
    select: { id: true, employeeName: true, netPay: true, payrollMonth: true, updatedAt: true },
    orderBy: { payrollMonth: 'asc' },
  });

  // Existing ledger rows keyed by payroll id.
  const existing = await prisma.ledgerEntry.findMany({
    where: { tenantId: t.id, deletedAt: null, linkedRecordType: 'payroll', linkedRecordId: { in: paid.map((p) => p.id) } },
    select: { linkedRecordId: true },
  });
  const has = new Set(existing.map((e) => e.linkedRecordId));

  let total = 0, count = 0;
  for (const p of paid) {
    if (has.has(p.id)) continue;
    const amount = num(p.netPay);
    if (amount <= 0) continue;
    total += amount; count++;
    if (!DRY && count <= 10) console.log(`   + ${p.employeeName} ₦${money(amount)} ${p.payrollMonth?.toISOString().slice(0, 7)}`);
    if (!DRY) {
      await prisma.ledgerEntry.create({
        data: {
          tenantId: t.id, type: 'expense', amount, currency: 'NGN', category: 'Payroll',
          description: `Payroll ${p.payrollMonth?.toISOString().slice(0, 7)} — ${p.employeeName}`,
          linkedRecordType: 'payroll', linkedRecordId: p.id,
          date: p.payrollMonth ?? p.updatedAt,
        },
      });
      await rollup(t.id, p.payrollMonth ?? p.updatedAt, amount, 'NGN');
    }
  }
  console.log(`\n${DRY ? 'would post' : 'posted'} ${count} payroll expense rows totalling ₦${money(total)}`);
  console.log(DRY ? 'dry run — re-run with --apply to write.' : 'done.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
