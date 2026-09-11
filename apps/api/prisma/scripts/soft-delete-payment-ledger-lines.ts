/**
 * Soft-delete historical Customer/Supplier Payment P&L lines.
 * Cash stays on Payment + AccountTransaction; those rows were double-counting.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/soft-delete-payment-ledger-lines.ts
 *   npx ts-node --transpile-only prisma/scripts/soft-delete-payment-ledger-lines.ts --execute
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');

async function main() {
  const where = {
    deletedAt: null,
    category: { in: ['Customer Payment', 'Supplier Payment'] },
  };
  const count = await prisma.ledgerEntry.count({ where });
  console.log(
    dryRun
      ? `Would soft-delete ${count} payment ledger line(s). Re-run with --execute.`
      : `Soft-deleting ${count} payment ledger line(s)…`,
  );
  if (dryRun || count === 0) return;
  const result = await prisma.ledgerEntry.updateMany({
    where,
    data: { deletedAt: new Date() },
  });
  console.log(`Updated ${result.count} row(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
