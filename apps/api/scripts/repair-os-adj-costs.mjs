#!/usr/bin/env node
/**
 * One-off reversal of backfilled cost rows booked on OS/ (opening stock)
 * and ADJ/ (stock adjustment) movements. Those references record stock
 * truth — per openingStockMovement.ts they are NEVER supplier purchases,
 * so their value must not sit in P&L costs.
 *
 * Reversal = soft-delete the ledger row + post a negative rollup delta.
 * Idempotent: only touches non-deleted (backfill) rows matching OS|ADJ.
 *
 *   npm run audit:repair-os-adj -- --dry-run
 *   npm run audit:repair-os-adj -- --apply
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

const prisma = new PrismaClient();

function dayStart(date) {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

async function main() {
  console.log(`OS/ADJ cost reversal (${APPLY ? 'APPLY' : 'dry run'})`);
  const rows = await prisma.ledgerEntry.findMany({
    where: {
      description: { contains: '(backfill)' },
      type: 'cost',
      deletedAt: null,
    },
  });
  const bad = rows.filter((r) => /Inbound (OS|ADJ)\//.test(r.description));
  console.log(`backfill cost rows: ${rows.length} | OS/ADJ to reverse: ${bad.length}`);

  let reversed = 0;
  for (const r of bad) {
    const amount = Number(r.amount);
    if (DRY) {
      if (reversed < 10) console.log(`  would reverse ${r.description} amount=${amount}`);
      reversed++;
      continue;
    }
    await prisma.ledgerEntry.update({
      where: { id: r.id },
      data: { deletedAt: new Date() },
    });
    const day = dayStart(new Date(r.date));
    await prisma.tenantDailyFinance.upsert({
      where: { tenantId_date: { tenantId: r.tenantId, date: day } },
      create: {
        id: `${r.tenantId}:${day.toISOString().slice(0, 10)}`,
        tenantId: r.tenantId,
        date: day,
        revenue: 0,
        costs: -amount,
        expenses: 0,
        net: amount,
        currency: r.currency ?? 'NGN',
      },
      update: {
        costs: { increment: -amount },
        net: { increment: amount },
      },
    });
    reversed++;
    if (reversed % 100 === 0) console.log(`  … ${reversed} reversed`);
  }
  console.log(DRY ? `dry run: ${reversed} would reverse` : `reversed ${reversed} rows`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
