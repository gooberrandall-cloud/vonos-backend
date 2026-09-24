/**
 * Soft-delete ALL active expenses for selected tenants (default: VS, VKW),
 * plus linked account transactions, expense ledger rows, and expense invoices.
 *
 * Does not touch sales, purchases, items, customers, or non-expense payments.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/purge-tenant-expenses.ts
 *   npx ts-node --transpile-only prisma/scripts/purge-tenant-expenses.ts --execute
 *   TENANT_CODES=VS,VKW npx ts-node --transpile-only prisma/scripts/purge-tenant-expenses.ts --execute
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');

const DEFAULT_CODES = ['VS', 'VKW'] as const;
const codes = (process.env.TENANT_CODES ?? DEFAULT_CODES.join(','))
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

const BATCH = 150;

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        /closed the connection|Can't reach database|P1017|P1001|timed out/i.test(
          msg,
        );
      console.warn(`  retry ${i}/${attempts} ${label}: ${msg.slice(0, 120)}`);
      if (!retryable || i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 800 * i));
      try {
        await prisma.$connect();
      } catch {
        /* ignore */
      }
    }
  }
  throw last;
}

async function chunkedIds(
  fetchPage: (cursor: string | undefined) => Promise<Array<{ id: string }>>,
): Promise<string[]> {
  const all: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    if (page.length === 0) break;
    for (const row of page) all.push(row.id);
    if (page.length < BATCH) break;
    cursor = page[page.length - 1]!.id;
  }
  return all;
}

async function main() {
  if (codes.length === 0) {
    console.error('No TENANT_CODES provided');
    process.exit(1);
  }

  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, code: { in: codes } },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });

  if (tenants.length === 0) {
    console.error(`No tenants found for: ${codes.join(', ')}`);
    process.exit(1);
  }

  const missing = codes.filter((c) => !tenants.some((t) => t.code === c));
  if (missing.length) {
    console.warn(`Missing tenants (skipped): ${missing.join(', ')}`);
  }

  console.log(
    dryRun
      ? 'DRY-RUN — pass --execute to soft-delete expenses'
      : 'EXECUTE — soft-deleting all expenses for selected tenants',
  );
  console.log(`Tenants: ${tenants.map((t) => t.code).join(', ')}`);
  console.log('');

  const now = new Date();
  let totalExpenses = 0;

  for (const tenant of tenants) {
    const expenseWhere = { tenantId: tenant.id, deletedAt: null as null };

    const [expenses, ledgerExpense, acctTxn, invoices, sum] =
      await Promise.all([
        prisma.expense.count({ where: expenseWhere }),
        prisma.ledgerEntry.count({
          where: {
            tenantId: tenant.id,
            deletedAt: null,
            linkedRecordType: 'expense',
          },
        }),
        prisma.accountTransaction.count({
          where: {
            tenantId: tenant.id,
            deletedAt: null,
            expenseId: { not: null },
          },
        }),
        prisma.invoice.count({
          where: {
            tenantId: tenant.id,
            deletedAt: null,
            expenseId: { not: null },
          },
        }),
        prisma.expense.aggregate({
          where: expenseWhere,
          _sum: { totalAmount: true },
        }),
      ]);

    totalExpenses += expenses;
    console.log(`[${tenant.code}] ${tenant.name}`);
    console.log(
      `  expenses=${expenses} ledger=${ledgerExpense} acctTxn=${acctTxn} invoices=${invoices} totalAmount=${Number(sum._sum.totalAmount ?? 0)}`,
    );

    if (dryRun || expenses === 0) {
      if (!dryRun && expenses === 0) console.log('  already empty');
      continue;
    }

    const expenseIds = await chunkedIds((cursor) =>
      prisma.expense.findMany({
        where: expenseWhere,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );

    for (let i = 0; i < expenseIds.length; i += BATCH) {
      const batch = expenseIds.slice(i, i + BATCH);
      await withRetry(`expense acctTxn ${batch.length}`, () =>
        prisma.accountTransaction.updateMany({
          where: {
            tenantId: tenant.id,
            deletedAt: null,
            expenseId: { in: batch },
          },
          data: { deletedAt: now },
        }),
      );
      await withRetry(`expense ledger ${batch.length}`, () =>
        prisma.ledgerEntry.updateMany({
          where: {
            tenantId: tenant.id,
            deletedAt: null,
            linkedRecordType: 'expense',
            linkedRecordId: { in: batch },
          },
          data: { deletedAt: now },
        }),
      );
      await withRetry(`expense invoice ${batch.length}`, () =>
        prisma.$executeRaw`
          UPDATE "Invoice"
          SET
            "deletedAt" = ${now},
            "reference" = "reference" || '__cleared_' || RIGHT(id, 8)
          WHERE "expenseId" IN (${Prisma.join(batch)})
            AND "deletedAt" IS NULL
        `,
      );
      await withRetry(`expense soft-delete ${batch.length}`, () =>
        prisma.expense.updateMany({
          where: { id: { in: batch }, deletedAt: null },
          data: { deletedAt: now },
        }),
      );
    }

    const remaining = await prisma.expense.count({ where: expenseWhere });
    console.log(`  done — remaining active expenses=${remaining}`);
  }

  console.log('');
  console.log(
    dryRun
      ? `Dry-run complete. Would soft-delete expenses=${totalExpenses}.`
      : `Execute complete. Soft-deleted expenses=${totalExpenses}.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
