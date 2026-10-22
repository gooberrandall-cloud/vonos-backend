#!/usr/bin/env node
/**
 * Normalize legacy Job.status labels to the canonical stage names.
 *   "Delivered"    -> "Vehicle collected"
 *   "In Progress"  -> "In progress"
 *
 * Uses raw SQL so `updatedAt` (which drives report date windows) is NOT bumped.
 *
 * Dry-run by default. Apply with:
 *   node --env-file=.env scripts/normalize-job-statuses.mjs --execute
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--execute');

const MAP = [
  { from: 'Delivered', to: 'Vehicle collected' },
  { from: 'In Progress', to: 'In progress' },
];

async function counts() {
  const rows = await prisma.job.groupBy({ by: ['status'], _count: true });
  const map = new Map(rows.map((r) => [r.status, r._count]));
  const keys = [...map.keys()].sort();
  return { map, keys };
}

const before = await counts();
console.log('BEFORE:');
for (const k of before.keys) console.log(`   ${JSON.stringify(k).padEnd(24)} ${before.map.get(k)}`);

let changed = 0;
for (const { from, to } of MAP) {
  const n = before.map.get(from) ?? 0;
  if (n > 0) {
    console.log(`\n${APPLY ? 'UPDATING' : 'WOULD UPDATE'} ${JSON.stringify(from)} (${n}) -> ${JSON.stringify(to)}`);
    if (APPLY) {
      const res = await prisma.$executeRawUnsafe(
        `UPDATE "Job" SET "status" = '${to}' WHERE "status" = '${from}'`,
      );
      changed += res;
    }
  }
}

if (!APPLY) {
  console.log('\n(dry-run — no writes. re-run with --execute to apply)');
} else {
  const after = await counts();
  console.log('\nAFTER:');
  for (const k of after.keys) console.log(`   ${JSON.stringify(k).padEnd(24)} ${after.map.get(k)}`);
  console.log(`\nrows updated: ${changed}`);
}

await prisma.$disconnect();
