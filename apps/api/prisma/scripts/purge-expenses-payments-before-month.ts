/**
 * Soft-delete expenses + payments dated before this calendar month
 * (Africa/Lagos). Keeps August 2026+ only.
 *
 * Also soft-deletes linked account txns, ledger rows, and expense invoices.
 * Does not touch sales, purchases, items, customers, or invoice schemes.
 *
 * Payment date = paidOn when set, else createdAt.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/purge-expenses-payments-before-month.ts
 *   npx ts-node --transpile-only prisma/scripts/purge-expenses-payments-before-month.ts --execute
 *   TENANT_CODE=VISP npx ts-node --transpile-only prisma/scripts/purge-expenses-payments-before-month.ts --execute
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');
const onlyCode = (process.env.TENANT_CODE ?? '').trim().toUpperCase();

/** Keep records on/after 1 Aug 2026 00:00 Africa/Lagos. */
const CUTOFF = new Date('2026-08-01T00:00:00+01:00');

const OPERATING = [
  'VA',
  'VW',
  'VISP',
  'VSP',
  'VP',
  'VC',
  'VS',
  'VKW',
] as const;

const BATCH = 150;

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
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

/** Payment is "before cutoff" if paidOn < cutoff, or paidOn null and createdAt < cutoff. */
const paymentBeforeCutoff = {
  OR: [
    { paidOn: { lt: CUTOFF } },
    { AND: [{ paidOn: null }, { createdAt: { lt: CUTOFF } }] },
  ],
} as const;

const paymentThisMonth = {
  OR: [
    { paidOn: { gte: CUTOFF } },
    { AND: [{ paidOn: null }, { createdAt: { gte: CUTOFF } }] },
  ],
} as const;

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      code: onlyCode ? onlyCode : { in: [...OPERATING] },
    },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });

  if (tenants.length === 0) {
    console.error(
      onlyCode
        ? `No tenant found for code ${onlyCode}`
        : 'No operating tenants found',
    );
    process.exit(1);
  }

  console.log(
    dryRun
      ? 'DRY-RUN — pass --execute to apply'
      : 'EXECUTE — soft-deleting pre-August expenses & payments',
  );
  console.log(`Cutoff: date < ${CUTOFF.toISOString()} (before Aug 2026 Lagos)`);
  console.log(`Tenants: ${tenants.map((t) => t.code).join(', ')}`);
  console.log('');

  const now = new Date();
  let totalExpenses = 0;
  let totalPayments = 0;

  for (const tenant of tenants) {
    const expenseWhere = {
      tenantId: tenant.id,
      deletedAt: null,
      expenseDate: { lt: CUTOFF },
    };
    const paymentWhere = {
      tenantId: tenant.id,
      deletedAt: null,
      ...paymentBeforeCutoff,
    };

    const [expenses, payments, keepExpenses, keepPayments] = await Promise.all([
      prisma.expense.count({ where: expenseWhere }),
      prisma.payment.count({ where: paymentWhere }),
      prisma.expense.count({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          expenseDate: { gte: CUTOFF },
        },
      }),
      prisma.payment.count({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          ...paymentThisMonth,
        },
      }),
    ]);

    totalExpenses += expenses;
    totalPayments += payments;

    console.log(`[${tenant.code}]`);
    console.log(
      `  purge: expenses=${expenses} payments=${payments} | keep this month: expenses=${keepExpenses} payments=${keepPayments}`,
    );

    if (dryRun) continue;

    if (expenses > 0) {
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
              "reference" = "reference" || '__preaug_' || RIGHT(id, 8)
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
    }

    if (payments > 0) {
      const paymentIds = await chunkedIds((cursor) =>
        prisma.payment.findMany({
          where: paymentWhere,
          select: { id: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      );

      for (let i = 0; i < paymentIds.length; i += BATCH) {
        const batch = paymentIds.slice(i, i + BATCH);
        await withRetry(`payment acctTxn ${batch.length}`, () =>
          prisma.accountTransaction.updateMany({
            where: {
              tenantId: tenant.id,
              deletedAt: null,
              paymentId: { in: batch },
            },
            data: { deletedAt: now },
          }),
        );
        await withRetry(`payment soft-delete ${batch.length}`, () =>
          prisma.payment.updateMany({
            where: { id: { in: batch }, deletedAt: null },
            data: { deletedAt: now },
          }),
        );
      }
    }

    console.log(`  done`);
  }

  console.log('');
  console.log(
    dryRun
      ? `Dry-run complete. Would purge expenses=${totalExpenses} payments=${totalPayments}.`
      : `Execute complete. Purged expenses=${totalExpenses} payments=${totalPayments}.`,
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
