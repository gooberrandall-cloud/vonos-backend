/**
 * Probe signals that separate imported vs app payments / account book rows.
 *
 *   npx ts-node --transpile-only prisma/scripts/probe-payment-origin-signals.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url:
        (process.env.DATABASE_URL ?? '') +
        ((process.env.DATABASE_URL ?? '').includes('?') ? '&' : '?') +
        'connection_limit=1&pool_timeout=60&connect_timeout=30',
    },
  },
});

async function q<T>(label: string, sql: string): Promise<T> {
  console.log(`\n=== ${label} ===`);
  const rows = await prisma.$queryRawUnsafe<T>(sql);
  console.log(JSON.stringify(rows, null, 2));
  return rows;
}

async function main() {
  await q(
    'Legacy entityTypes (payment-related)',
    `SELECT "entityType", COUNT(*)::int AS n
     FROM "MigrationLegacyId"
     WHERE "entityType" ILIKE '%pay%'
        OR "entityType" ILIKE '%account%'
     GROUP BY 1 ORDER BY n DESC`,
  );

  await q(
    'Active payments: legacy map vs not',
    `SELECT
       CASE WHEN m.id IS NULL THEN 'no_legacy_map' ELSE 'has_legacy_map' END AS bucket,
       COUNT(*)::int AS n
     FROM "Payment" p
     LEFT JOIN "MigrationLegacyId" m
       ON m."newId" = p.id AND m."entityType" = 'payment'
     WHERE p."deletedAt" IS NULL
     GROUP BY 1`,
  );

  await q(
    'Active payments: paymentRefNo prefix',
    `SELECT
       CASE
         WHEN "paymentRefNo" IS NULL OR btrim("paymentRefNo") = '' THEN '(empty)'
         WHEN "paymentRefNo" ~ '^SP' THEN 'SP… (UPOS sell receipt)'
         WHEN "paymentRefNo" ~ '^PP' THEN 'PP… (UPOS purchase receipt)'
         WHEN "paymentRefNo" ~ '^PO-' THEN 'PO-… (app purchase ref)'
         WHEN "paymentRefNo" ~ '^SALE-' THEN 'SALE-…'
         WHEN "paymentRefNo" ~ '^[0-9]+$' THEN 'numeric_only'
         ELSE 'other'
       END AS prefix,
       COUNT(*)::int AS n
     FROM "Payment"
     WHERE "deletedAt" IS NULL
     GROUP BY 1 ORDER BY n DESC`,
  );

  await q(
    'Active payments: paymentFor values',
    `SELECT COALESCE("paymentFor",'(null)') AS payment_for, COUNT(*)::int AS n
     FROM "Payment" WHERE "deletedAt" IS NULL
     GROUP BY 1 ORDER BY n DESC`,
  );

  await q(
    'Active payments: link completeness',
    `SELECT
       CASE
         WHEN "saleId" IS NOT NULL THEN 'has_saleId'
         WHEN "invoiceId" IS NOT NULL THEN 'has_invoiceId_only'
         WHEN "paymentFor" = 'purchase' AND "paymentRefNo" IS NOT NULL THEN 'purchase_by_ref'
         WHEN "accountId" IS NULL THEN 'no_account'
         ELSE 'account_only_or_other'
       END AS link,
       COUNT(*)::int AS n
     FROM "Payment" WHERE "deletedAt" IS NULL
     GROUP BY 1 ORDER BY n DESC`,
  );

  await q(
    'Active payments: createdByName vs users',
    `SELECT
       CASE
         WHEN p."createdByName" IS NULL OR btrim(p."createdByName") = '' THEN 'empty_name'
         WHEN EXISTS (
           SELECT 1 FROM "User" u
           WHERE u."deletedAt" IS NULL
             AND (
               lower(u.name) = lower(p."createdByName")
               OR lower(u.email) = lower(p."createdByName")
             )
         ) THEN 'matches_vonos_user'
         ELSE 'name_not_in_users'
       END AS who,
       COUNT(*)::int AS n
     FROM "Payment" p
     WHERE p."deletedAt" IS NULL
     GROUP BY 1 ORDER BY n DESC`,
  );

  await q(
    'Active payments: paidOn vs createdAt gap (days)',
    `SELECT
       CASE
         WHEN "paidOn" IS NULL THEN 'paidOn_null'
         WHEN abs(EXTRACT(EPOCH FROM ("createdAt" - "paidOn"))) < 3600 THEN 'within_1h'
         WHEN abs(EXTRACT(EPOCH FROM ("createdAt" - "paidOn"))) < 86400 THEN 'within_1d'
         WHEN "createdAt"::date - "paidOn"::date > 7 THEN 'created_much_later_than_paid (batch import?)'
         ELSE 'other_gap'
       END AS gap,
       COUNT(*)::int AS n
     FROM "Payment" WHERE "deletedAt" IS NULL
     GROUP BY 1 ORDER BY n DESC`,
  );

  await q(
    'AuditLog for payment entity (app writes)',
    `SELECT action, COUNT(*)::int AS n
     FROM "AuditLog"
     WHERE "entityType" = 'payment'
     GROUP BY 1 ORDER BY n DESC
     LIMIT 20`,
  );

  await q(
    'Active book: subtype + link matrix',
    `SELECT
       COALESCE("subType",'(null)') AS subtype,
       ("paymentId" IS NOT NULL) AS has_payment,
       ("saleId" IS NOT NULL) AS has_sale,
       ("expenseId" IS NOT NULL) AS has_expense,
       COUNT(*)::int AS n
     FROM "AccountTransaction"
     WHERE "deletedAt" IS NULL
     GROUP BY 1,2,3,4
     ORDER BY n DESC
     LIMIT 30`,
  );

  await q(
    'Active book: legacy account_transaction map?',
    `SELECT "entityType", COUNT(*)::int AS n
     FROM "MigrationLegacyId"
     WHERE "entityType" ILIKE '%account_transaction%'
        OR "entityType" ILIKE '%acct%'
     GROUP BY 1`,
  );

  await q(
    'Cross: payment has legacy map AND has audit log',
    `SELECT
       COUNT(*) FILTER (
         WHERE m.id IS NOT NULL AND a.id IS NOT NULL
       )::int AS legacy_and_audited,
       COUNT(*) FILTER (
         WHERE m.id IS NOT NULL AND a.id IS NULL
       )::int AS legacy_no_audit,
       COUNT(*) FILTER (
         WHERE m.id IS NULL AND a.id IS NOT NULL
       )::int AS no_legacy_but_audited,
       COUNT(*) FILTER (
         WHERE m.id IS NULL AND a.id IS NULL
       )::int AS no_legacy_no_audit
     FROM "Payment" p
     LEFT JOIN "MigrationLegacyId" m
       ON m."newId" = p.id AND m."entityType" = 'payment'
     LEFT JOIN LATERAL (
       SELECT id FROM "AuditLog" al
       WHERE al."entityType" = 'payment' AND al."entityId" = p.id
       LIMIT 1
     ) a ON true
     WHERE p."deletedAt" IS NULL`,
  );

  await q(
    'Sample: no_legacy + audited (likely app)',
    `SELECT p.id, p."paymentRefNo", p."paymentFor", p."createdByName",
            p."paidOn", p."createdAt", p.method, p."saleId" IS NOT NULL AS has_sale
     FROM "Payment" p
     WHERE p."deletedAt" IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM "MigrationLegacyId" m
         WHERE m."newId" = p.id AND m."entityType" = 'payment'
       )
       AND EXISTS (
         SELECT 1 FROM "AuditLog" al
         WHERE al."entityType" = 'payment' AND al."entityId" = p.id
       )
     ORDER BY p."createdAt" DESC
     LIMIT 5`,
  );

  await q(
    'Sample: has_legacy (imported)',
    `SELECT p.id, p."paymentRefNo", p."paymentFor", p."createdByName",
            p."paidOn", p."createdAt", p.method
     FROM "Payment" p
     JOIN "MigrationLegacyId" m
       ON m."newId" = p.id AND m."entityType" = 'payment'
     WHERE p."deletedAt" IS NULL
     ORDER BY p."createdAt" DESC
     LIMIT 5`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
