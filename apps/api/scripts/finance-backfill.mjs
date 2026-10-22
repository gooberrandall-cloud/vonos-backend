#!/usr/bin/env node
/**
 * Gap-filling backfill for finance rows the app used to skip.
 * IDEMPOTENT — every write is guarded by an existence check, so re-runs
 * and overlaps with live traffic never double-book.
 *
 * What it repairs:
 *  A. Inbound purchases saved directly as Received (the purchase UI default)
 *     that never got a cost ledger row → creates it + daily rollup delta.
 *  B. Paid store orders whose sales lack revenue ledger rows and/or outbound
 *     stock movements (early test data) → creates them + rollup delta.
 *     Store payments with no till account are REPORTED only — assigning a
 *     till needs a human decision.
 *
 * Usage:
 *   npm run audit:backfill -- --dry-run [--tenant <id>] [--limit 200]
 *   npm run audit:backfill -- --apply   [--tenant <id>] [--limit 200]
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const APPLY = args.includes('--apply');
const tenantScope = option('--tenant');
const LIMIT = Math.max(1, Number(option('--limit') ?? 500));

const prisma = new PrismaClient();
const num = (v) => Number(v ?? 0);
let created = 0;

async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

function dayStart(date) {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

async function rollupDelta(tenantId, date, type, amount, currency, dry) {
  if (type !== 'revenue' && type !== 'cost' && type !== 'expense') return;
  const day = dayStart(new Date(date));
  const delta = {
    revenue: type === 'revenue' ? amount : 0,
    costs: type === 'cost' ? amount : 0,
    expenses: type === 'expense' ? amount : 0,
    net: type === 'revenue' ? amount : -amount,
  };
  if (dry) return;
  await prisma.tenantDailyFinance.upsert({
    where: { tenantId_date: { tenantId, date: day } },
    create: {
      id: `${tenantId}:${day.toISOString().slice(0, 10)}`,
      tenantId,
      date: day,
      ...delta,
      currency,
    },
    update: {
      revenue: { increment: delta.revenue },
      costs: { increment: delta.costs },
      expenses: { increment: delta.expenses },
      net: { increment: delta.net },
      currency,
    },
  });
}

async function backfillPurchaseCosts(dry) {
  console.log('\n== A. Missing purchase cost rows ==');
  const inbound = await prisma.stockMovement.findMany({
    where: {
      ...(tenantScope ? { tenantId: tenantScope } : {}),
      type: 'inbound',
      status: 'Received',
      deletedAt: null,
      // OS/ (opening stock) and ADJ/ (adjustment) record stock truth, not
      // supplier purchases — never book cost for them.
      NOT: [
        { reference: { startsWith: 'OS/' } },
        { reference: { startsWith: 'ADJ/' } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: LIMIT,
  });
  let skipped = 0;
  // One batched existence check instead of N findFirst round-trips
  // (Neon pooler connection budget is shared with live traffic).
  const existingRows = await prisma.ledgerEntry.findMany({
    where: {
      linkedRecordType: 'stock_movement',
      type: 'cost',
      deletedAt: null,
      ...(tenantScope ? { tenantId: tenantScope } : {}),
    },
    select: { linkedRecordId: true },
  });
  const booked = new Set(existingRows.map((r) => r.linkedRecordId));
  let wouldCreate = 0;
  for (const m of inbound) {
    const lines = Array.isArray(m.lines) ? m.lines : [];
    const totalCost = lines.reduce(
      (s, l) => s + (Number(l.unitCost ?? 0) || 0) * Number(l.quantity ?? 0),
      0,
    );
    if (!(totalCost > 0) || booked.has(m.id)) {
      skipped++;
      continue;
    }
    if (dry) {
      wouldCreate++;
      if (wouldCreate <= 25) {
        console.log(`  would create cost ${m.tenantId} inbound=${m.reference} amount=${totalCost}`);
      }
      continue;
    }
    await prisma.ledgerEntry.create({
      data: {
        tenantId: m.tenantId,
        type: 'cost',
        amount: totalCost,
        currency: 'NGN',
        category: 'Purchases',
        description: `Inbound ${m.reference} (backfill)`,
        linkedRecordType: 'stock_movement',
        linkedRecordId: m.id,
        date: m.date,
      },
    });
    await rollupDelta(m.tenantId, m.date, 'cost', totalCost, 'NGN', dry);
    booked.add(m.id);
    created++;
    if (created % 100 === 0) console.log(`  … ${created} cost rows written`);
  }
  console.log(`  done: ${dry ? `would create ${wouldCreate}` : `created ${created}`} cost rows, skipped ${skipped} (zero cost or already booked)`);
}

async function backfillStoreSales(dry) {
  console.log('\n== B. Store sales missing revenue / movement ==');
  const links = await prisma.storeOrderSale.findMany({
    where: tenantScope ? { tenantId: tenantScope } : {},
    include: {
      order: true,
      sale: { include: { lines: true, payments: true } },
    },
    take: LIMIT,
  });
  for (const l of links) {
    const sale = l.sale;
    const total = num(sale.total);

    const rev = await prisma.ledgerEntry.findFirst({
      where: {
        tenantId: sale.tenantId,
        linkedRecordType: 'sale',
        linkedRecordId: sale.id,
        type: 'revenue',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!rev && total > 0) {
      console.log(
        `  ${dry ? 'would create' : 'creating'} revenue order=${l.order.reference} sale=${sale.reference} amount=${total}`,
      );
      if (!dry) {
        await prisma.ledgerEntry.create({
          data: {
            tenantId: sale.tenantId,
            type: 'revenue',
            amount: total,
            currency: sale.currency ?? 'NGN',
            category: 'Sales',
            description: `Online store ${l.order.reference} (${sale.reference}) (backfill)`,
            linkedRecordType: 'sale',
            linkedRecordId: sale.id,
            date: sale.date,
          },
        });
        await rollupDelta(sale.tenantId, sale.date, 'revenue', total, sale.currency ?? 'NGN', dry);
        created++;
      }
    }

    const movement = await prisma.stockMovement.findFirst({
      where: {
        tenantId: sale.tenantId,
        type: 'outbound',
        notes: { contains: sale.id },
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!movement && sale.lines.length) {
      console.log(
        `  ${dry ? 'would create' : 'creating'} outbound movement sale=${sale.reference} lines=${sale.lines.length}`,
      );
      if (!dry) {
        await prisma.stockMovement.create({
          data: {
            tenantId: sale.tenantId,
            type: 'outbound',
            reference: `SO-${sale.reference}`,
            status: 'Delivered',
            lines: sale.lines.map((line) => ({
              itemId: line.itemId,
              sku: line.sku,
              name: line.name,
              quantity: line.quantity,
              unitCost: 0,
            })),
            itemCount: sale.lines.length,
            grandTotal: 0,
            notes: `saleId:${sale.id}|store ${l.order.reference} (backfill)`,
            date: sale.date,
          },
        });
        created++;
      }
    }

    for (const p of sale.payments) {
      if (!p.accountId) {
        console.log(
          `  ! payment ${p.id} amount=${p.amount} has no till account — assign manually (not auto-fixed)`,
        );
      }
    }
  }
  console.log('  done.');
}

async function main() {
  console.log(`finance backfill (${APPLY ? 'APPLY — will write' : 'dry run — no writes'})`);
  await backfillPurchaseCosts(!APPLY);
  await backfillStoreSales(!APPLY);
  console.log(`\n${APPLY ? `wrote ${created} row(s)` : 'dry run complete — re-run with --apply to write'}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
