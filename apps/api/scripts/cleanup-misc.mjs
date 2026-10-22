#!/usr/bin/env node
/**
 * Small data-integrity cleanups. Idempotent, dry-run by default.
 *
 *   npm run audit:cleanup-misc -- --dry-run
 *   npm run audit:cleanup-misc -- --apply
 *
 * A. Cancel abandoned store orders: status=pending_payment older than 24h
 *    that never completed Paystack payment (abandoned carts).
 * B. Negative on-hand stock: set quantity to 0 (out_of_stock) — flagged by
 *    the finance audit. Reported, never silently mass-changed.
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;
const prisma = new PrismaClient();

async function main() {
  console.log(`MISC CLEANUP (${APPLY ? 'APPLY' : 'dry-run'})`);
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);

  // A. Abandoned pending store orders
  const abandoned = await prisma.storeOrder.findMany({
    where: { status: 'pending_payment', createdAt: { lt: cutoff } },
    select: { id: true, reference: true, total: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\nA. abandoned pending store orders (>24h): ${abandoned.length}`);
  for (const o of abandoned) console.log(`   ${o.reference} ₦${Number(o.total)} ${o.createdAt.toISOString().slice(0, 10)}`);

  // B. Negative stock
  const negative = await prisma.item.findMany({
    where: { deletedAt: null, quantity: { lt: 0 } },
    select: { id: true, tenantId: true, sku: true, name: true, quantity: true },
  });
  console.log(`\nB. items with negative on-hand: ${negative.length}`);
  for (const i of negative) console.log(`   ${i.tenantId} ${i.sku} qty=${i.quantity} (${(i.name ?? '').slice(0, 40)})`);

  if (DRY) {
    console.log('\nDRY RUN — re-run with --apply to write.');
    return;
  }

  let cancelled = 0;
  for (const o of abandoned) {
    await prisma.storeOrder.update({ where: { id: o.id }, data: { status: 'cancelled' } });
    cancelled++;
  }

  let fixedStock = 0;
  for (const i of negative) {
    await prisma.item.update({
      where: { id: i.id },
      data: { quantity: 0, status: 'out_of_stock' },
    });
    fixedStock++;
  }

  console.log(`\nAPPLIED: ${cancelled} orders cancelled, ${fixedStock} items set to 0.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
