/**
 * Recompute Sale / purchase StockMovement.paymentStatus from payment sums.
 *
 * Migration copied Ultimate POS labels (and used to default null → paid), so
 * many rows show Paid while Sell Due / Payment due still have a balance.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/backfill-payment-status-from-amounts.ts
 *   DRY_RUN=1 TENANT_CODE=VA ...
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const TENANT_CODE = process.env.TENANT_CODE?.trim() || null;

function statusFrom(total: number, paid: number, previous: string | null): string {
  if (paid <= 1e-6) return previous === 'overdue' ? 'overdue' : 'due';
  if (paid + 1e-6 < total) return 'partial';
  return 'paid';
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN' : 'WRITE', { TENANT_CODE });

  const tenants = await prisma.tenant.findMany({
    where: TENANT_CODE ? { code: TENANT_CODE } : undefined,
    select: { id: true, code: true },
  });

  let saleUpdates = 0;
  let purchaseUpdates = 0;

  for (const tenant of tenants) {
    const saleRows = await prisma.$queryRaw<
      Array<{
        id: string;
        reference: string;
        st: string | null;
        total: number;
        paid: number;
      }>
    >`
      SELECT s.id, s.reference, s."paymentStatus"::text AS st,
        s.total::float AS total,
        COALESCE((
          SELECT SUM(pay.amount)::float FROM "Payment" pay
          WHERE pay."deletedAt" IS NULL AND pay."isReturn" = false
            AND (
              pay."saleId" = s.id
              OR pay."invoiceId" IN (
                SELECT i.id FROM "Invoice" i
                WHERE i."saleId" = s.id AND i."deletedAt" IS NULL
              )
            )
        ), 0) AS paid
      FROM "Sale" s
      WHERE s."tenantId" = ${tenant.id} AND s."deletedAt" IS NULL
    `;

    for (const row of saleRows) {
      const next = statusFrom(row.total, row.paid, row.st);
      if (next === (row.st ?? 'due')) continue;
      saleUpdates += 1;
      if (saleUpdates <= 20) {
        console.log(
          `[${tenant.code}] sale ${row.reference}: ${row.st} → ${next} (total=${row.total} paid=${row.paid})`,
        );
      }
      if (!DRY_RUN) {
        await prisma.sale.update({
          where: { id: row.id },
          data: { paymentStatus: next as 'paid' | 'partial' | 'due' | 'overdue' },
        });
      }
    }

    const purchRows = await prisma.$queryRaw<
      Array<{
        id: string;
        reference: string;
        st: string | null;
        total: number;
        paid: number;
      }>
    >`
      SELECT m.id, m.reference, m."paymentStatus"::text AS st,
        COALESCE(m."grandTotal", 0)::float AS total,
        COALESCE((
          SELECT SUM(pay.amount)::float FROM "Payment" pay
          WHERE pay."deletedAt" IS NULL AND pay."isReturn" = false
            AND (
              (pay."paymentFor" = 'purchase' AND pay."paymentRefNo" = m.reference)
              OR pay."invoiceId" IN (
                SELECT i.id FROM "Invoice" i
                WHERE i."stockMovementId" = m.id AND i."deletedAt" IS NULL
              )
            )
        ), 0) AS paid
      FROM "StockMovement" m
      WHERE m."tenantId" = ${tenant.id}
        AND m."deletedAt" IS NULL
        AND m.type = 'inbound'
    `;

    for (const row of purchRows) {
      const next = statusFrom(row.total, row.paid, row.st);
      if (next === (row.st ?? 'due')) continue;
      purchaseUpdates += 1;
      if (purchaseUpdates <= 20) {
        console.log(
          `[${tenant.code}] purch ${row.reference}: ${row.st} → ${next} (total=${row.total} paid=${row.paid})`,
        );
      }
      if (!DRY_RUN) {
        await prisma.stockMovement.update({
          where: { id: row.id },
          data: { paymentStatus: next as 'paid' | 'partial' | 'due' | 'overdue' },
        });
      }
    }

    console.log(`[${tenant.code}] done`);
  }

  console.log({ saleUpdates, purchaseUpdates, DRY_RUN });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
