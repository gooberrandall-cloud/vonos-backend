/**
 * Full accounting / finance system audit against live Postgres.
 * Read-only. Usage: cd apps/api && ../../node_modules/.bin/tsx prisma/scripts/audit-finance-system.ts
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';

function loadDotEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    if (process.env[key]) continue;
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(resolve(__dirname, '../../.env'));
const prisma = new PrismaClient();

async function main() {
  const tenants = await prisma.$queryRaw<
    Array<{ id: string; code: string; name: string }>
  >`
    SELECT id, code, name FROM "Tenant"
    WHERE "deletedAt" IS NULL AND code <> 'VAG'
    ORDER BY code
  `;

  const byTenant = await prisma.$queryRaw<
    Array<{
      code: string;
      sales: number;
      sale_total: number;
      sales_final: number;
      sales_quote: number;
      sales_draft: number;
      payments: number;
      payment_sum: number;
      expenses: number;
      expense_sum: number;
      payrolls: number;
      payroll_sum: number;
      ledger_rev_rows: number;
      ledger_rev: number;
      ledger_cost_rows: number;
      ledger_cost: number;
      ledger_exp_rows: number;
      ledger_exp: number;
      pay_ledger_rows: number;
      pay_ledger_sum: number;
      deleted_pay_ledger: number;
      internal_flag_rows: number;
      inbound: number;
      inbound_grand: number;
      accounts: number;
      acct_txns: number;
      daily_finance_days: number;
      daily_rev: number;
      daily_exp: number;
    }>
  >`
    SELECT
      t.code,
      (SELECT COUNT(*)::int FROM "Sale" s WHERE s."tenantId"=t.id AND s."deletedAt" IS NULL) AS sales,
      (SELECT COALESCE(SUM(s.total),0)::float FROM "Sale" s WHERE s."tenantId"=t.id AND s."deletedAt" IS NULL) AS sale_total,
      (SELECT COUNT(*)::int FROM "Sale" s WHERE s."tenantId"=t.id AND s."deletedAt" IS NULL AND s.status='completed') AS sales_final,
      (SELECT COUNT(*)::int FROM "Sale" s WHERE s."tenantId"=t.id AND s."deletedAt" IS NULL AND s.status='quotation') AS sales_quote,
      (SELECT COUNT(*)::int FROM "Sale" s WHERE s."tenantId"=t.id AND s."deletedAt" IS NULL AND s.status='draft') AS sales_draft,
      (SELECT COUNT(*)::int FROM "Payment" p WHERE p."tenantId"=t.id AND p."deletedAt" IS NULL) AS payments,
      (SELECT COALESCE(SUM(p.amount),0)::float FROM "Payment" p WHERE p."tenantId"=t.id AND p."deletedAt" IS NULL) AS payment_sum,
      (SELECT COUNT(*)::int FROM "Expense" e WHERE e."tenantId"=t.id AND e."deletedAt" IS NULL) AS expenses,
      (SELECT COALESCE(SUM(e."totalAmount"),0)::float FROM "Expense" e WHERE e."tenantId"=t.id AND e."deletedAt" IS NULL) AS expense_sum,
      (SELECT COUNT(*)::int FROM "Payroll" pr WHERE pr."tenantId"=t.id AND pr."deletedAt" IS NULL) AS payrolls,
      (SELECT COALESCE(SUM(pr."netPay"),0)::float FROM "Payroll" pr WHERE pr."tenantId"=t.id AND pr."deletedAt" IS NULL) AS payroll_sum,
      (SELECT COUNT(*)::int FROM "LedgerEntry" l WHERE l."tenantId"=t.id AND l."deletedAt" IS NULL AND l.type='revenue') AS ledger_rev_rows,
      (SELECT COALESCE(SUM(l.amount),0)::float FROM "LedgerEntry" l WHERE l."tenantId"=t.id AND l."deletedAt" IS NULL AND l.type='revenue') AS ledger_rev,
      (SELECT COUNT(*)::int FROM "LedgerEntry" l WHERE l."tenantId"=t.id AND l."deletedAt" IS NULL AND l.type='cost') AS ledger_cost_rows,
      (SELECT COALESCE(SUM(l.amount),0)::float FROM "LedgerEntry" l WHERE l."tenantId"=t.id AND l."deletedAt" IS NULL AND l.type='cost') AS ledger_cost,
      (SELECT COUNT(*)::int FROM "LedgerEntry" l WHERE l."tenantId"=t.id AND l."deletedAt" IS NULL AND l.type='expense') AS ledger_exp_rows,
      (SELECT COALESCE(SUM(l.amount),0)::float FROM "LedgerEntry" l WHERE l."tenantId"=t.id AND l."deletedAt" IS NULL AND l.type='expense') AS ledger_exp,
      (SELECT COUNT(*)::int FROM "LedgerEntry" l WHERE l."tenantId"=t.id AND l."deletedAt" IS NULL AND l.category IN ('Customer Payment','Supplier Payment')) AS pay_ledger_rows,
      (SELECT COALESCE(SUM(l.amount),0)::float FROM "LedgerEntry" l WHERE l."tenantId"=t.id AND l."deletedAt" IS NULL AND l.category IN ('Customer Payment','Supplier Payment')) AS pay_ledger_sum,
      (SELECT COUNT(*)::int FROM "LedgerEntry" l WHERE l."tenantId"=t.id AND l."deletedAt" IS NOT NULL AND l.category IN ('Customer Payment','Supplier Payment')) AS deleted_pay_ledger,
      (SELECT COUNT(*)::int FROM "LedgerEntry" l WHERE l."tenantId"=t.id AND l."deletedAt" IS NULL AND l."isInternalTransfer"=true) AS internal_flag_rows,
      (SELECT COUNT(*)::int FROM "StockMovement" m WHERE m."tenantId"=t.id AND m."deletedAt" IS NULL AND m.type='inbound') AS inbound,
      (SELECT COALESCE(SUM(m."grandTotal"),0)::float FROM "StockMovement" m WHERE m."tenantId"=t.id AND m."deletedAt" IS NULL AND m.type='inbound') AS inbound_grand,
      (SELECT COUNT(*)::int FROM "PaymentAccount" a WHERE a."tenantId"=t.id AND a."deletedAt" IS NULL) AS accounts,
      (SELECT COUNT(*)::int FROM "AccountTransaction" x WHERE x."tenantId"=t.id AND x."deletedAt" IS NULL) AS acct_txns,
      (SELECT COUNT(*)::int FROM "TenantDailyFinance" f WHERE f."tenantId"=t.id) AS daily_finance_days,
      (SELECT COALESCE(SUM(f.revenue),0)::float FROM "TenantDailyFinance" f WHERE f."tenantId"=t.id) AS daily_rev,
      (SELECT COALESCE(SUM(f.expenses),0)::float FROM "TenantDailyFinance" f WHERE f."tenantId"=t.id) AS daily_exp
    FROM "Tenant" t
    WHERE t."deletedAt" IS NULL AND t.code <> 'VAG'
    ORDER BY t.code
  `;

  const ledgerCategories = await prisma.$queryRaw<
    Array<{ type: string; category: string; rows: number; amount: number }>
  >`
    SELECT type::text AS type, COALESCE(category,'(blank)') AS category,
           COUNT(*)::int AS rows, COALESCE(SUM(amount),0)::float AS amount
    FROM "LedgerEntry"
    WHERE "deletedAt" IS NULL
    GROUP BY type, category
    ORDER BY type, SUM(amount) DESC
  `;

  const linkedTypes = await prisma.$queryRaw<
    Array<{ linked: string; type: string; rows: number; amount: number }>
  >`
    SELECT COALESCE("linkedRecordType",'(none)') AS linked, type::text AS type,
           COUNT(*)::int AS rows, COALESCE(SUM(amount),0)::float AS amount
    FROM "LedgerEntry"
    WHERE "deletedAt" IS NULL
    GROUP BY 1, 2
    ORDER BY 3 DESC
  `;

  const gaps = await prisma.$queryRaw<
    Array<{ check: string; count: number }>
  >`
    SELECT 'final_sales_without_revenue_ledger' AS check, COUNT(*)::int AS count
    FROM "Sale" s
    WHERE s."deletedAt" IS NULL AND s.status = 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM "LedgerEntry" l
        WHERE l."deletedAt" IS NULL AND l.type='revenue'
          AND l."linkedRecordType"='sale' AND l."linkedRecordId"=s.id
          AND l.category NOT IN ('Customer Payment','Supplier Payment')
      )
    UNION ALL
    SELECT 'expenses_without_ledger', COUNT(*)::int
    FROM "Expense" e
    WHERE e."deletedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "LedgerEntry" l
        WHERE l."deletedAt" IS NULL AND l.type='expense'
          AND (
            (l."linkedRecordType"='expense' AND l."linkedRecordId"=e.id)
            OR l."invoiceId" IN (SELECT i.id FROM "Invoice" i WHERE i."expenseId"=e.id)
          )
      )
    UNION ALL
    SELECT 'payrolls_without_ledger', COUNT(*)::int
    FROM "Payroll" p
    WHERE p."deletedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "LedgerEntry" l
        WHERE l."deletedAt" IS NULL AND l.type='expense'
          AND l."linkedRecordType" IN ('payroll','payroll_group')
          AND (l."linkedRecordId"=p.id OR l."invoiceId" IN (
            SELECT i.id FROM "Invoice" i WHERE i."payrollId"=p.id
          ))
      )
    UNION ALL
    SELECT 'inbound_without_cost_ledger', COUNT(*)::int
    FROM "StockMovement" m
    WHERE m."deletedAt" IS NULL AND m.type='inbound'
      AND COALESCE(m."grandTotal",0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM "LedgerEntry" l
        WHERE l."deletedAt" IS NULL AND l.type='cost'
          AND l."linkedRecordType"='stock_movement' AND l."linkedRecordId"=m.id
      )
    UNION ALL
    SELECT 'payments_without_account_txn', COUNT(*)::int
    FROM "Payment" p
    WHERE p."deletedAt" IS NULL AND p."accountId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "AccountTransaction" x
        WHERE x."deletedAt" IS NULL AND x."paymentId"=p.id
      )
    UNION ALL
    SELECT 'active_customer_payment_ledger', COUNT(*)::int
    FROM "LedgerEntry" l
    WHERE l."deletedAt" IS NULL AND l.category='Customer Payment'
    UNION ALL
    SELECT 'active_supplier_payment_ledger', COUNT(*)::int
    FROM "LedgerEntry" l
    WHERE l."deletedAt" IS NULL AND l.category='Supplier Payment'
    UNION ALL
    SELECT 'soft_deleted_payment_ledger', COUNT(*)::int
    FROM "LedgerEntry" l
    WHERE l."deletedAt" IS NOT NULL AND l.category IN ('Customer Payment','Supplier Payment')
    UNION ALL
    SELECT 'internal_transfer_flagged', COUNT(*)::int
    FROM "LedgerEntry" l
    WHERE l."deletedAt" IS NULL AND l."isInternalTransfer"=true
    UNION ALL
    SELECT 'job_and_sale_same_amount_revenue_pairs', COUNT(*)::int
    FROM "LedgerEntry" j
    WHERE j."deletedAt" IS NULL AND j.type='revenue' AND j."linkedRecordType"='job'
      AND EXISTS (
        SELECT 1 FROM "LedgerEntry" s
        WHERE s."deletedAt" IS NULL AND s.type='revenue' AND s."linkedRecordType"='sale'
          AND s."tenantId"=j."tenantId"
          AND ABS(s.amount - j.amount) < 0.01
          AND ABS(EXTRACT(EPOCH FROM (s.date - j.date))) < 120
      )
  `;

  const vaDelta = await prisma.$queryRaw<
    Array<{
      sale_completed_total: number;
      ledger_sales_rev: number;
      ledger_customer_pay_rev: number;
      ledger_rev_all: number;
      payment_on_sales: number;
      expense_table: number;
      ledger_expense: number;
      payroll_table: number;
      daily_rev: number;
      daily_exp: number;
    }>
  >`
    SELECT
      (SELECT COALESCE(SUM(total),0)::float FROM "Sale" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL AND status='completed') AS sale_completed_total,
      (SELECT COALESCE(SUM(amount),0)::float FROM "LedgerEntry" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL AND type='revenue' AND category NOT IN ('Customer Payment','Supplier Payment')) AS ledger_sales_rev,
      (SELECT COALESCE(SUM(amount),0)::float FROM "LedgerEntry" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL AND category='Customer Payment') AS ledger_customer_pay_rev,
      (SELECT COALESCE(SUM(amount),0)::float FROM "LedgerEntry" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL AND type='revenue') AS ledger_rev_all,
      (SELECT COALESCE(SUM(p.amount),0)::float FROM "Payment" p JOIN "Sale" s ON s.id=p."saleId" WHERE p."tenantId"='tenant_va_001' AND p."deletedAt" IS NULL AND s."deletedAt" IS NULL) AS payment_on_sales,
      (SELECT COALESCE(SUM("totalAmount"),0)::float FROM "Expense" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL) AS expense_table,
      (SELECT COALESCE(SUM(amount),0)::float FROM "LedgerEntry" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL AND type='expense') AS ledger_expense,
      (SELECT COALESCE(SUM("netPay"),0)::float FROM "Payroll" WHERE "tenantId"='tenant_va_001' AND "deletedAt" IS NULL) AS payroll_table,
      (SELECT COALESCE(SUM(revenue),0)::float FROM "TenantDailyFinance" WHERE "tenantId"='tenant_va_001') AS daily_rev,
      (SELECT COALESCE(SUM(expenses),0)::float FROM "TenantDailyFinance" WHERE "tenantId"='tenant_va_001') AS daily_exp
  `;

  console.log(
    JSON.stringify(
      {
        auditedAt: new Date().toISOString(),
        tenantCount: tenants.length,
        byTenant,
        gaps,
        vaDelta: vaDelta[0],
        ledgerCategories: ledgerCategories.slice(0, 40),
        linkedTypes: linkedTypes.slice(0, 30),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
