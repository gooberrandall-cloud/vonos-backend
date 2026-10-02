/**
 * Soft-delete sales + purchases (inbound stock movements) dated before
 * this calendar month (Africa/Lagos). Keeps August 2026+ only.
 *
 * Also soft-deletes linked payments, account txns, ledger rows, invoices.
 * Does not touch expenses, items, customers, suppliers, or invoice schemes.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/purge-sales-purchases-before-month.ts
 *   npx ts-node --transpile-only prisma/scripts/purge-sales-purchases-before-month.ts --execute
 *   TENANT_CODE=VISP npx ts-node --transpile-only prisma/scripts/purge-sales-purchases-before-month.ts --execute
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
      : 'EXECUTE — soft-deleting pre-August sales & purchases',
  );
  console.log(`Cutoff: date < ${CUTOFF.toISOString()} (before Aug 2026 Lagos)`);
  console.log(`Tenants: ${tenants.map((t) => t.code).join(', ')}`);
  console.log('');

  const now = new Date();
  let totalSales = 0;
  let totalPurchases = 0;

  for (const tenant of tenants) {
    const saleWhere = {
      tenantId: tenant.id,
      deletedAt: null,
      date: { lt: CUTOFF },
    };
    const purchaseWhere = {
      tenantId: tenant.id,
      deletedAt: null,
      date: { lt: CUTOFF },
      type: 'inbound' as const,
    };

    const [sales, purchases, keepSales, keepPurchases] = await Promise.all([
      prisma.sale.count({ where: saleWhere }),
      prisma.stockMovement.count({ where: purchaseWhere }),
      prisma.sale.count({
        where: { tenantId: tenant.id, deletedAt: null, date: { gte: CUTOFF } },
      }),
      prisma.stockMovement.count({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          type: 'inbound',
          date: { gte: CUTOFF },
        },
      }),
    ]);

    totalSales += sales;
    totalPurchases += purchases;

    console.log(`[${tenant.code}]`);
    console.log(
      `  purge: sales=${sales} purchases=${purchases} | keep this month: sales=${keepSales} purchases=${keepPurchases}`,
    );

    if (dryRun) continue;

    if (sales > 0) {
      const saleIds = await chunkedIds((cursor) =>
        prisma.sale.findMany({
          where: saleWhere,
          select: { id: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      );

      for (let i = 0; i < saleIds.length; i += BATCH) {
        const batch = saleIds.slice(i, i + BATCH);
        await withRetry(`sale payments ${batch.length}`, () =>
          prisma.payment.updateMany({
            where: {
              tenantId: tenant.id,
              deletedAt: null,
              saleId: { in: batch },
            },
            data: { deletedAt: now },
          }),
        );
        await withRetry(`sale acctTxn ${batch.length}`, () =>
          prisma.accountTransaction.updateMany({
            where: {
              tenantId: tenant.id,
              deletedAt: null,
              saleId: { in: batch },
            },
            data: { deletedAt: now },
          }),
        );
        await withRetry(`sale ledger ${batch.length}`, () =>
          prisma.ledgerEntry.updateMany({
            where: {
              tenantId: tenant.id,
              deletedAt: null,
              linkedRecordType: 'sale',
              linkedRecordId: { in: batch },
            },
            data: { deletedAt: now },
          }),
        );
        await withRetry(`sale soft-delete ${batch.length}`, () =>
          prisma.$executeRaw`
            UPDATE "Sale"
            SET
              "deletedAt" = ${now},
              "jobId" = NULL,
              "reference" = "reference" || '__preaug_' || RIGHT(id, 8)
            WHERE id IN (${Prisma.join(batch)})
              AND "deletedAt" IS NULL
          `,
        );
        await withRetry(`sale invoice ${batch.length}`, () =>
          prisma.$executeRaw`
            UPDATE "Invoice"
            SET
              "deletedAt" = ${now},
              "jobId" = NULL,
              "reference" = "reference" || '__preaug_' || RIGHT(id, 8)
            WHERE "saleId" IN (${Prisma.join(batch)})
              AND "deletedAt" IS NULL
          `,
        );
      }
    }

    if (purchases > 0) {
      const movements = await prisma.stockMovement.findMany({
        where: purchaseWhere,
        select: { id: true, reference: true },
      });
      const movementIds = movements.map((r) => r.id);
      const refs = movements.map((r) => r.reference);

      for (let i = 0; i < movementIds.length; i += BATCH) {
        const batchIds = movementIds.slice(i, i + BATCH);
        const batchRefs = refs.slice(i, i + BATCH);

        const purchaseInvoices = await prisma.invoice.findMany({
          where: {
            tenantId: tenant.id,
            deletedAt: null,
            stockMovementId: { in: batchIds },
          },
          select: { id: true },
        });
        const invoiceIds = purchaseInvoices.map((r) => r.id);

        await withRetry(`purchase payments ${batchIds.length}`, () =>
          prisma.payment.updateMany({
            where: {
              tenantId: tenant.id,
              deletedAt: null,
              OR: [
                ...(invoiceIds.length > 0
                  ? [{ invoiceId: { in: invoiceIds } }]
                  : []),
                ...(batchRefs.length > 0
                  ? [
                      {
                        paymentFor: 'purchase',
                        paymentRefNo: { in: batchRefs },
                      },
                    ]
                  : []),
              ],
            },
            data: { deletedAt: now },
          }),
        );
        if (invoiceIds.length > 0) {
          await withRetry(`purchase acctTxn ${invoiceIds.length}`, () =>
            prisma.accountTransaction.updateMany({
              where: {
                tenantId: tenant.id,
                deletedAt: null,
                invoiceId: { in: invoiceIds },
              },
              data: { deletedAt: now },
            }),
          );
        }
        await withRetry(`purchase ledger ${batchIds.length}`, () =>
          prisma.ledgerEntry.updateMany({
            where: {
              tenantId: tenant.id,
              deletedAt: null,
              OR: [
                {
                  linkedRecordType: 'stock_movement',
                  linkedRecordId: { in: batchIds },
                },
                {
                  linkedRecordType: 'purchase',
                  linkedRecordId: { in: batchIds },
                },
              ],
            },
            data: { deletedAt: now },
          }),
        );
        if (invoiceIds.length > 0) {
          await withRetry(`purchase invoice ${invoiceIds.length}`, () =>
            prisma.$executeRaw`
              UPDATE "Invoice"
              SET
                "deletedAt" = ${now},
                "reference" = "reference" || '__preaug_' || RIGHT(id, 8)
              WHERE id IN (${Prisma.join(invoiceIds)})
                AND "deletedAt" IS NULL
            `,
          );
        }
        await withRetry(`purchase soft-delete ${batchIds.length}`, () =>
          prisma.stockMovement.updateMany({
            where: { id: { in: batchIds }, deletedAt: null },
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
      ? `Dry-run complete. Would purge sales=${totalSales} purchases=${totalPurchases}.`
      : `Execute complete. Purged sales=${totalSales} purchases=${totalPurchases}.`,
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
