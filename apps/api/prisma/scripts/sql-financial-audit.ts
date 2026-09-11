/**
 * Financial coverage audit — Postgres counts per Vonos tenant.
 *
 * Usage:
 *   cd apps/api && npx ts-node prisma/scripts/sql-financial-audit.ts
 *
 * Writes: docs/migration-audits/dryruns/FINANCIAL_POSTGRES_COUNTS.json
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';

const TENANT_CODES = ['VA', 'VISP', 'VSP', 'VW', 'VC', 'VKW', 'VS'] as const;

const OUT_PATH = join(
  __dirname,
  '../../../../docs/migration-audits/dryruns/FINANCIAL_POSTGRES_COUNTS.json',
);

type Row = Record<string, unknown>;

async function main() {
  const p = new PrismaClient();

  const tenants = (await p.$queryRawUnsafe(`
    SELECT id, code, name, archetype::text
    FROM "Tenant"
    WHERE code = ANY(ARRAY[${TENANT_CODES.map((c) => `'${c}'`).join(',')}])
    ORDER BY code
  `)) as Row[];

  const tenantByCode = new Map(
    tenants.map((t) => [String(t.code), String(t.id)]),
  );

  const perTenant: Record<string, Row> = {};

  for (const code of TENANT_CODES) {
    const tenantId = tenantByCode.get(code);
    if (!tenantId) {
      perTenant[code] = { error: 'tenant not found in database' };
      continue;
    }

    const ledgerByType = (await p.$queryRawUnsafe(`
      SELECT type::text AS type, COUNT(*)::int AS count,
             COALESCE(SUM(amount), 0)::text AS total_amount
      FROM "LedgerEntry"
      WHERE "tenantId" = '${tenantId}' AND "deletedAt" IS NULL
      GROUP BY type ORDER BY type
    `)) as Row[];

    const sales = (await p.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(total), 0)::text AS total_amount,
             MIN(date)::text AS date_min,
             MAX(date)::text AS date_max
      FROM "Sale"
      WHERE "tenantId" = '${tenantId}' AND "deletedAt" IS NULL
    `)) as Row[];

    const payments = (await p.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(amount), 0)::text AS total_amount
      FROM "Payment"
      WHERE "tenantId" = '${tenantId}' AND "deletedAt" IS NULL
    `)) as Row[];

    const expenses = (await p.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM("totalAmount"), 0)::text AS total_amount
      FROM "Expense"
      WHERE "tenantId" = '${tenantId}' AND "deletedAt" IS NULL
    `)) as Row[];

    const expenseCategories = (await p.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count FROM "ExpenseCategory"
      WHERE "tenantId" = '${tenantId}' AND "deletedAt" IS NULL
    `)) as Row[];

    const paymentAccounts = (await p.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count FROM "PaymentAccount"
      WHERE "tenantId" = '${tenantId}' AND "deletedAt" IS NULL
    `)) as Row[];

    const accountTransactions = (await p.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(amount), 0)::text AS total_amount
      FROM "AccountTransaction"
      WHERE "tenantId" = '${tenantId}' AND "deletedAt" IS NULL
    `)) as Row[];

    const payroll = (await p.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM("netPay"), 0)::text AS total_net
      FROM "Payroll"
      WHERE "tenantId" = '${tenantId}' AND "deletedAt" IS NULL
    `)) as Row[];

    const payrollGroups = (await p.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count FROM "PayrollGroup"
      WHERE "tenantId" = '${tenantId}' AND "deletedAt" IS NULL
    `)) as Row[];

    const payComponents = (await p.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count FROM "PayComponent"
      WHERE "tenantId" = '${tenantId}' AND "deletedAt" IS NULL
    `)) as Row[];

    const inboundMovements = (await p.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count FROM "StockMovement"
      WHERE "tenantId" = '${tenantId}' AND type = 'inbound' AND "deletedAt" IS NULL
    `)) as Row[];

    const revenueLedger = ledgerByType.find((r) => r.type === 'revenue');
    const expenseLedger = ledgerByType.find((r) => r.type === 'expense');
    const costLedger = ledgerByType.find((r) => r.type === 'cost');

    const saleRow = sales[0] ?? {};
    const paymentRow = payments[0] ?? {};

    const revenueAmount = revenueLedger?.total_amount
      ? Number(revenueLedger.total_amount)
      : 0;
    const saleTotal = saleRow.total_amount ? Number(saleRow.total_amount) : 0;
    const paymentTotal = paymentRow.total_amount
      ? Number(paymentRow.total_amount)
      : 0;

    perTenant[code] = {
      tenantId,
      ledgerByType,
      sales: saleRow,
      payments: paymentRow,
      expenses: expenses[0] ?? {},
      expenseCategories: expenseCategories[0] ?? {},
      paymentAccounts: paymentAccounts[0] ?? {},
      accountTransactions: accountTransactions[0] ?? {},
      payroll: payroll[0] ?? {},
      payrollGroups: payrollGroups[0] ?? {},
      payComponents: payComponents[0] ?? {},
      inboundStockMovements: inboundMovements[0] ?? {},
      tieOut: {
        saleTotalAmount: saleTotal,
        ledgerRevenueTotal: revenueAmount,
        paymentTotal,
        saleVsLedgerDelta: Math.abs(saleTotal - revenueAmount),
        saleVsPaymentDelta: Math.abs(saleTotal - paymentTotal),
        revenueTieOutPass:
          Math.abs(saleTotal - revenueAmount) <= 1 ||
          saleTotal === 0 ||
          revenueAmount === 0,
      },
      ledgerExpenseCount: expenseLedger?.count ?? 0,
      ledgerCostCount: costLedger?.count ?? 0,
    };
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    tenants: tenants.map((t) => ({
      code: t.code,
      id: t.id,
      name: t.name,
      archetype: t.archetype,
    })),
    perTenant,
  };

  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
  console.log(JSON.stringify(payload, null, 2));

  await p.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
