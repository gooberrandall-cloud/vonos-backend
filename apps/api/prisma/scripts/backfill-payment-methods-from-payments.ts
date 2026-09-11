/**
 * Backfill Sale.paymentMethod and inbound StockMovement.paymentMethod from Payment.
 *
 * Migration left parent-row paymentMethod null even when Payment.method was set.
 * For multi-method parents, prefer the method on the largest payment (then latest paidOn).
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/backfill-payment-methods-from-payments.ts
 *   DRY_RUN=1 ...
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function main() {
  console.log(DRY_RUN ? 'DRY RUN' : 'WRITE');

  const beforeSales = await prisma.$queryRaw<
    Array<{ total: number; with_method: number }>
  >`
    SELECT COUNT(*)::int AS total,
      SUM(CASE WHEN "paymentMethod" IS NOT NULL AND "paymentMethod" <> '' THEN 1 ELSE 0 END)::int AS with_method
    FROM "Sale"
    WHERE "deletedAt" IS NULL
  `;
  const beforePurch = await prisma.$queryRaw<
    Array<{ total: number; with_method: number }>
  >`
    SELECT COUNT(*)::int AS total,
      SUM(CASE WHEN "paymentMethod" IS NOT NULL AND "paymentMethod" <> '' THEN 1 ELSE 0 END)::int AS with_method
    FROM "StockMovement"
    WHERE "deletedAt" IS NULL AND type = 'inbound'
  `;
  console.log('before', { sales: beforeSales[0], purchases: beforePurch[0] });

  // Rank payments per sale: largest amount, then latest paidOn/createdAt.
  const saleCandidates = await prisma.$queryRaw<
    Array<{ saleId: string; method: string }>
  >`
    SELECT DISTINCT ON (pay."saleId")
      pay."saleId" AS "saleId",
      pay.method AS method
    FROM "Payment" pay
    JOIN "Sale" s ON s.id = pay."saleId"
    WHERE pay."deletedAt" IS NULL
      AND pay."saleId" IS NOT NULL
      AND pay.method IS NOT NULL
      AND pay.method <> ''
      AND s."deletedAt" IS NULL
      AND (s."paymentMethod" IS NULL OR s."paymentMethod" = '')
    ORDER BY pay."saleId", pay.amount DESC NULLS LAST,
      COALESCE(pay."paidOn", pay."createdAt") DESC
  `;
  console.log(`sale patches: ${saleCandidates.length}`);

  // Purchase methods via paymentFor=purchase + paymentRefNo = movement.reference
  const purchByRef = await prisma.$queryRaw<
    Array<{ movementId: string; method: string }>
  >`
    SELECT DISTINCT ON (m.id)
      m.id AS "movementId",
      pay.method AS method
    FROM "StockMovement" m
    JOIN "Payment" pay
      ON pay."tenantId" = m."tenantId"
     AND pay."deletedAt" IS NULL
     AND pay."paymentFor" = 'purchase'
     AND pay."paymentRefNo" = m.reference
     AND pay.method IS NOT NULL
     AND pay.method <> ''
    WHERE m."deletedAt" IS NULL
      AND m.type = 'inbound'
      AND (m."paymentMethod" IS NULL OR m."paymentMethod" = '')
    ORDER BY m.id, pay.amount DESC NULLS LAST,
      COALESCE(pay."paidOn", pay."createdAt") DESC
  `;
  console.log(`purchase patches (by ref): ${purchByRef.length}`);

  // Purchase methods via Invoice link (fills gaps not matched by ref)
  const purchByInvoice = await prisma.$queryRaw<
    Array<{ movementId: string; method: string }>
  >`
    SELECT DISTINCT ON (m.id)
      m.id AS "movementId",
      pay.method AS method
    FROM "StockMovement" m
    JOIN "Invoice" i ON i."stockMovementId" = m.id
    JOIN "Payment" pay
      ON pay."invoiceId" = i.id
     AND pay."deletedAt" IS NULL
     AND pay.method IS NOT NULL
     AND pay.method <> ''
    WHERE m."deletedAt" IS NULL
      AND m.type = 'inbound'
      AND (m."paymentMethod" IS NULL OR m."paymentMethod" = '')
    ORDER BY m.id, pay.amount DESC NULLS LAST,
      COALESCE(pay."paidOn", pay."createdAt") DESC
  `;
  console.log(`purchase patches (by invoice): ${purchByInvoice.length}`);

  const purchMap = new Map<string, string>();
  for (const row of purchByRef) purchMap.set(row.movementId, row.method);
  for (const row of purchByInvoice) {
    if (!purchMap.has(row.movementId)) {
      purchMap.set(row.movementId, row.method);
    }
  }
  console.log(`purchase patches (merged): ${purchMap.size}`);

  if (DRY_RUN) {
    console.log('Dry run — no writes', {
      salePatches: saleCandidates.length,
      purchasePatches: purchMap.size,
    });
    return;
  }

  // Bulk update sales from ranked payments
  const saleResult = await prisma.$executeRaw`
    UPDATE "Sale" s
    SET "paymentMethod" = ranked.method
    FROM (
      SELECT DISTINCT ON (pay."saleId")
        pay."saleId" AS sale_id,
        pay.method AS method
      FROM "Payment" pay
      WHERE pay."deletedAt" IS NULL
        AND pay."saleId" IS NOT NULL
        AND pay.method IS NOT NULL
        AND pay.method <> ''
      ORDER BY pay."saleId", pay.amount DESC NULLS LAST,
        COALESCE(pay."paidOn", pay."createdAt") DESC
    ) ranked
    WHERE s.id = ranked.sale_id
      AND s."deletedAt" IS NULL
      AND (s."paymentMethod" IS NULL OR s."paymentMethod" = '')
  `;
  console.log(`sales updated: ${saleResult}`);

  // Bulk update purchases by payment ref
  const purchRefResult = await prisma.$executeRaw`
    UPDATE "StockMovement" m
    SET "paymentMethod" = ranked.method
    FROM (
      SELECT DISTINCT ON (m2.id)
        m2.id AS movement_id,
        pay.method AS method
      FROM "StockMovement" m2
      JOIN "Payment" pay
        ON pay."tenantId" = m2."tenantId"
       AND pay."deletedAt" IS NULL
       AND pay."paymentFor" = 'purchase'
       AND pay."paymentRefNo" = m2.reference
       AND pay.method IS NOT NULL
       AND pay.method <> ''
      WHERE m2."deletedAt" IS NULL
        AND m2.type = 'inbound'
      ORDER BY m2.id, pay.amount DESC NULLS LAST,
        COALESCE(pay."paidOn", pay."createdAt") DESC
    ) ranked
    WHERE m.id = ranked.movement_id
      AND (m."paymentMethod" IS NULL OR m."paymentMethod" = '')
  `;
  console.log(`purchases updated (by ref): ${purchRefResult}`);

  // Fill remaining purchases via invoice
  const purchInvResult = await prisma.$executeRaw`
    UPDATE "StockMovement" m
    SET "paymentMethod" = ranked.method
    FROM (
      SELECT DISTINCT ON (m2.id)
        m2.id AS movement_id,
        pay.method AS method
      FROM "StockMovement" m2
      JOIN "Invoice" i ON i."stockMovementId" = m2.id
      JOIN "Payment" pay
        ON pay."invoiceId" = i.id
       AND pay."deletedAt" IS NULL
       AND pay.method IS NOT NULL
       AND pay.method <> ''
      WHERE m2."deletedAt" IS NULL
        AND m2.type = 'inbound'
      ORDER BY m2.id, pay.amount DESC NULLS LAST,
        COALESCE(pay."paidOn", pay."createdAt") DESC
    ) ranked
    WHERE m.id = ranked.movement_id
      AND (m."paymentMethod" IS NULL OR m."paymentMethod" = '')
  `;
  console.log(`purchases updated (by invoice): ${purchInvResult}`);

  const afterSales = await prisma.$queryRaw<
    Array<{ total: number; with_method: number }>
  >`
    SELECT COUNT(*)::int AS total,
      SUM(CASE WHEN "paymentMethod" IS NOT NULL AND "paymentMethod" <> '' THEN 1 ELSE 0 END)::int AS with_method
    FROM "Sale"
    WHERE "deletedAt" IS NULL
  `;
  const afterPurch = await prisma.$queryRaw<
    Array<{ total: number; with_method: number }>
  >`
    SELECT COUNT(*)::int AS total,
      SUM(CASE WHEN "paymentMethod" IS NOT NULL AND "paymentMethod" <> '' THEN 1 ELSE 0 END)::int AS with_method
    FROM "StockMovement"
    WHERE "deletedAt" IS NULL AND type = 'inbound'
  `;
  const byTenant = await prisma.$queryRaw<
    Array<{ code: string; sales_with: number; sales_total: number; purch_with: number; purch_total: number }>
  >`
    SELECT t.code,
      (SELECT COUNT(*)::int FROM "Sale" s WHERE s."tenantId" = t.id AND s."deletedAt" IS NULL
        AND s."paymentMethod" IS NOT NULL AND s."paymentMethod" <> '') AS sales_with,
      (SELECT COUNT(*)::int FROM "Sale" s WHERE s."tenantId" = t.id AND s."deletedAt" IS NULL) AS sales_total,
      (SELECT COUNT(*)::int FROM "StockMovement" m WHERE m."tenantId" = t.id AND m."deletedAt" IS NULL
        AND m.type = 'inbound' AND m."paymentMethod" IS NOT NULL AND m."paymentMethod" <> '') AS purch_with,
      (SELECT COUNT(*)::int FROM "StockMovement" m WHERE m."tenantId" = t.id AND m."deletedAt" IS NULL
        AND m.type = 'inbound') AS purch_total
    FROM "Tenant" t
    ORDER BY t.code
  `;
  console.log('Done', {
    after: { sales: afterSales[0], purchases: afterPurch[0] },
    byTenant,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
