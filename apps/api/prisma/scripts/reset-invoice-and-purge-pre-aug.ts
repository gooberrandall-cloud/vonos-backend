/**
 * Reset invoice schemes to year/0001 and optionally soft-delete sales,
 * expenses, and purchases (inbound stock movements) dated before 31 Jul 2026.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/reset-invoice-and-purge-pre-aug.ts
 *   npx ts-node --transpile-only prisma/scripts/reset-invoice-and-purge-pre-aug.ts --dry-run
 *   npx ts-node --transpile-only prisma/scripts/reset-invoice-and-purge-pre-aug.ts --execute
 *   TENANT_CODE=VA npx ts-node --transpile-only prisma/scripts/reset-invoice-and-purge-pre-aug.ts --execute
 *
 * Default is dry-run (counts only). Pass --execute to apply.
 * Does not touch master data (items, customers, suppliers, jobs).
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');
const onlyCode = (process.env.TENANT_CODE ?? '').trim().toUpperCase();

/** Exclusive upper bound: keep records on/after 2026-07-31. */
const CUTOFF = new Date('2026-07-31T00:00:00.000Z');

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

function yearPrefix(at = new Date()): string {
  return `${at.getFullYear()}/`;
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
      : 'EXECUTE — writing changes',
  );
  console.log(`Cutoff: date < ${CUTOFF.toISOString()} (before 31 Jul 2026)`);
  console.log(`Tenants: ${tenants.map((t) => t.code).join(', ')}`);
  console.log('');

  const now = new Date();
  const prefix = yearPrefix(now);

  for (const tenant of tenants) {
    const saleWhere = {
      tenantId: tenant.id,
      deletedAt: null,
      date: { lt: CUTOFF },
    };
    const expenseWhere = {
      tenantId: tenant.id,
      deletedAt: null,
      expenseDate: { lt: CUTOFF },
    };
    const purchaseWhere = {
      tenantId: tenant.id,
      deletedAt: null,
      date: { lt: CUTOFF },
      type: 'inbound' as const,
    };

    const [sales, expenses, purchases, schemes] = await Promise.all([
      prisma.sale.count({ where: saleWhere }),
      prisma.expense.count({ where: expenseWhere }),
      prisma.stockMovement.count({ where: purchaseWhere }),
      prisma.invoiceScheme.findMany({
        where: { tenantId: tenant.id, deletedAt: null },
        select: {
          id: true,
          name: true,
          prefix: true,
          startNumber: true,
          invoiceCount: true,
          isDefault: true,
        },
      }),
    ]);

    console.log(`[${tenant.code}]`);
    console.log(
      `  purge candidates: sales=${sales} expenses=${expenses} purchases=${purchases}`,
    );
    console.log(
      `  schemes (${schemes.length}): ${
        schemes
          .map(
            (s) =>
              `${s.name}${s.isDefault ? '*' : ''} ${s.prefix ?? '∅'} count=${s.invoiceCount}`,
          )
          .join('; ') || 'none'
      }`,
    );

    if (dryRun) continue;

    if (sales > 0) {
      const saleIds = (
        await prisma.sale.findMany({
          where: saleWhere,
          select: { id: true },
        })
      ).map((r) => r.id);

      await prisma.payment.updateMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          saleId: { in: saleIds },
        },
        data: { deletedAt: now },
      });
      await prisma.accountTransaction.updateMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          saleId: { in: saleIds },
        },
        data: { deletedAt: now },
      });
      await prisma.ledgerEntry.updateMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          linkedRecordType: 'sale',
          linkedRecordId: { in: saleIds },
        },
        data: { deletedAt: now },
      });

      // Unique (tenantId, reference) / (tenantId, jobId) survive soft-delete.
      await prisma.$executeRaw`
        UPDATE "Sale"
        SET
          "deletedAt" = ${now},
          "jobId" = NULL,
          "reference" = "reference" || '__preaug_' || RIGHT(id, 8)
        WHERE id IN (${Prisma.join(saleIds)})
      `;
      await prisma.$executeRaw`
        UPDATE "Invoice"
        SET
          "deletedAt" = ${now},
          "jobId" = NULL,
          "reference" = "reference" || '__preaug_' || RIGHT(id, 8)
        WHERE "saleId" IN (${Prisma.join(saleIds)})
          AND "deletedAt" IS NULL
      `;
    }

    if (expenses > 0) {
      const expenseIds = (
        await prisma.expense.findMany({
          where: expenseWhere,
          select: { id: true },
        })
      ).map((r) => r.id);

      await prisma.ledgerEntry.updateMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          linkedRecordType: 'expense',
          linkedRecordId: { in: expenseIds },
        },
        data: { deletedAt: now },
      });
      await prisma.$executeRaw`
        UPDATE "Invoice"
        SET
          "deletedAt" = ${now},
          "reference" = "reference" || '__preaug_' || RIGHT(id, 8)
        WHERE "expenseId" IN (${Prisma.join(expenseIds)})
          AND "deletedAt" IS NULL
      `;
      await prisma.expense.updateMany({
        where: { id: { in: expenseIds } },
        data: { deletedAt: now },
      });
    }

    if (purchases > 0) {
      const movements = await prisma.stockMovement.findMany({
        where: purchaseWhere,
        select: { id: true, reference: true },
      });
      const movementIds = movements.map((r) => r.id);
      const refs = movements.map((r) => r.reference);

      const purchaseInvoices = await prisma.invoice.findMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          stockMovementId: { in: movementIds },
        },
        select: { id: true },
      });
      const invoiceIds = purchaseInvoices.map((r) => r.id);

      await prisma.payment.updateMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          OR: [
            ...(invoiceIds.length > 0
              ? [{ invoiceId: { in: invoiceIds } }]
              : []),
            ...(refs.length > 0
              ? [{ paymentFor: 'purchase', paymentRefNo: { in: refs } }]
              : []),
          ],
        },
        data: { deletedAt: now },
      });
      await prisma.ledgerEntry.updateMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          OR: [
            {
              linkedRecordType: 'stock_movement',
              linkedRecordId: { in: movementIds },
            },
            {
              linkedRecordType: 'purchase',
              linkedRecordId: { in: movementIds },
            },
          ],
        },
        data: { deletedAt: now },
      });
      if (invoiceIds.length > 0) {
        await prisma.$executeRaw`
          UPDATE "Invoice"
          SET
            "deletedAt" = ${now},
            "reference" = "reference" || '__preaug_' || RIGHT(id, 8)
          WHERE id IN (${Prisma.join(invoiceIds)})
        `;
      }
      await prisma.stockMovement.updateMany({
        where: { id: { in: movementIds } },
        data: { deletedAt: now },
      });
    }

    if (schemes.length === 0) {
      await prisma.invoiceScheme.create({
        data: {
          tenantId: tenant.id,
          name: 'Default',
          prefix,
          startNumber: 1,
          invoiceCount: 0,
          totalDigits: 4,
          isDefault: true,
        },
      });
      console.log(`  created default scheme ${prefix}0001`);
    } else {
      for (const scheme of schemes) {
        await prisma.invoiceScheme.update({
          where: { id: scheme.id },
          data: {
            prefix,
            startNumber: 1,
            invoiceCount: 0,
            totalDigits: 4,
          },
        });
      }
      console.log(`  reset ${schemes.length} scheme(s) → ${prefix}0001`);
    }

    console.log(`  done`);
  }

  console.log('');
  console.log(dryRun ? 'Dry-run complete.' : 'Execute complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
