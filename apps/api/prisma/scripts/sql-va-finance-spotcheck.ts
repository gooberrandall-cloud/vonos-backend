import { PrismaClient } from '@prisma/client';

const VA = 'tenant_va_001';

type Check = {
  name: string;
  pass: boolean;
  actual: string | number;
  expected: string | number;
  note?: string;
};

const TARGETS = {
  payrolls: 1910,
  payrollGroups: 196,
  payComponents: 4,
  expenses: 12_623,
  paymentAccounts: 104,
  inboundMovements: 7982,
  jobsMin: 16_000,
} as const;

async function main() {
  const prisma = new PrismaClient();
  const checks: Check[] = [];

  const [
    jobCount,
    payrollCount,
    payrollGroupCount,
    payComponentCount,
    expenseCount,
    ledgerExpenseCount,
    paymentAccountCount,
    inboundCount,
    costLedgerCount,
    paymentCount,
    ledgerRevenue,
    recentJobs,
  ] = await Promise.all([
    prisma.job.count({ where: { tenantId: VA, deletedAt: null } }),
    prisma.payroll.count({ where: { tenantId: VA } }),
    prisma.payrollGroup.count({ where: { tenantId: VA } }),
    prisma.payComponent.count({ where: { tenantId: VA } }),
    prisma.expense.count({ where: { tenantId: VA, deletedAt: null } }),
    prisma.ledgerEntry.count({
      where: { tenantId: VA, deletedAt: null, type: 'expense' },
    }),
    prisma.paymentAccount.count({ where: { tenantId: VA, deletedAt: null } }),
    prisma.stockMovement.count({
      where: { tenantId: VA, deletedAt: null, type: 'inbound' },
    }),
    prisma.ledgerEntry.count({
      where: { tenantId: VA, deletedAt: null, type: 'cost' },
    }),
    prisma.payment.count({ where: { tenantId: VA, deletedAt: null } }),
    prisma.ledgerEntry.aggregate({
      where: { tenantId: VA, deletedAt: null, type: 'revenue' },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.job.findMany({
      where: { tenantId: VA, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        reference: true,
        customerName: true,
        customerId: true,
        status: true,
        invoiceAmount: true,
        quoteAmount: true,
      },
    }),
  ]);

  const leftoverVm = await prisma.job.count({
    where: { tenantId: { in: ['tenant_vm_001', 'tenant_vms_001'] } },
  });

  checks.push({
    name: 'VA jobs imported',
    pass: jobCount >= TARGETS.jobsMin,
    actual: jobCount,
    expected: `>= ${TARGETS.jobsMin}`,
  });
  checks.push({
    name: 'HRM payrolls',
    pass: payrollCount === TARGETS.payrolls,
    actual: payrollCount,
    expected: TARGETS.payrolls,
  });
  checks.push({
    name: 'HRM payroll groups',
    pass: payrollGroupCount === TARGETS.payrollGroups,
    actual: payrollGroupCount,
    expected: TARGETS.payrollGroups,
  });
  checks.push({
    name: 'HRM pay components',
    pass: payComponentCount === TARGETS.payComponents,
    actual: payComponentCount,
    expected: TARGETS.payComponents,
  });
  checks.push({
    name: 'Expense table rows',
    pass: expenseCount >= TARGETS.expenses * 0.99,
    actual: expenseCount,
    expected: `~${TARGETS.expenses}`,
  });
  checks.push({
    name: 'Ledger expense >= Expense table',
    pass: ledgerExpenseCount >= expenseCount,
    actual: ledgerExpenseCount,
    expected: `>= ${expenseCount}`,
    note: 'Ledger includes payroll + manual entries',
  });
  checks.push({
    name: 'Payment accounts',
    pass: paymentAccountCount >= TARGETS.paymentAccounts,
    actual: paymentAccountCount,
    expected: `>= ${TARGETS.paymentAccounts}`,
  });
  checks.push({
    name: 'Inbound purchases',
    pass: inboundCount >= TARGETS.inboundMovements * 0.99,
    actual: inboundCount,
    expected: `~${TARGETS.inboundMovements}`,
  });
  checks.push({
    name: 'Cost ledger matches inbound',
    pass: Math.abs(costLedgerCount - inboundCount) <= 50,
    actual: costLedgerCount,
    expected: `~${inboundCount}`,
  });
  checks.push({
    name: 'Payments recorded',
    pass: paymentCount > 0,
    actual: paymentCount,
    expected: '> 0',
  });
  checks.push({
    name: 'Job revenue ledger present',
    pass: (ledgerRevenue._count ?? 0) > 0,
    actual: ledgerRevenue._count ?? 0,
    expected: '> 0',
    note: `Revenue total ₦${Number(ledgerRevenue._sum.amount ?? 0).toLocaleString()}`,
  });
  checks.push({
    name: 'No leftover VM/VMS tenant jobs',
    pass: leftoverVm === 0,
    actual: leftoverVm,
    expected: '0',
  });
  checks.push({
    name: 'Recent jobs have customer link',
    pass: recentJobs.filter((j) => j.customerId).length >= 3,
    actual: recentJobs.filter((j) => j.customerId).length,
    expected: '>= 3 of 5 recent',
  });

  const failed = checks.filter((c) => !c.pass);
  const report = {
    tenantId: VA,
    generatedAt: new Date().toISOString(),
    pass: failed.length === 0,
    summary: `${checks.length - failed.length}/${checks.length} checks passed`,
    checks,
    recentJobSamples: recentJobs,
    manualUiSpotCheck: [
      'Open /VA/finance — ledger + P&L tabs load',
      'Open /VA/expenses — list non-empty',
      'Open /VA/payment-accounts — ~104 accounts',
      'Reports → profit-loss (All time) returns two-column P&L',
      'Open 5 recent jobs — amounts + customer link',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
