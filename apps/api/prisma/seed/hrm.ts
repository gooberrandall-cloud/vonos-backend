import type { PrismaClient } from '@prisma/client';

/** Sample HRM rows when no migrated payroll exists yet. */
export async function seedHrmDemo(prisma: PrismaClient): Promise<void> {
  const tenants = [
    { tenantId: 'tenant_vw_001', code: 'VW' },
    { tenantId: 'tenant_visp_001', code: 'VISP' },
  ] as const;

  for (const { tenantId, code } of tenants) {
    const existing = await prisma.payroll.count({
      where: { tenantId, deletedAt: null },
    });
    if (existing > 0) {
      continue;
    }
    const group = await prisma.payrollGroup.upsert({
      where: { id: `payroll_group_${code.toLowerCase()}_001` },
      create: {
        id: `payroll_group_${code.toLowerCase()}_001`,
        tenantId,
        name: 'General Staff',
      },
      update: { name: 'General Staff', deletedAt: null },
    });

    await prisma.payComponent.upsert({
      where: { id: `pay_component_${code.toLowerCase()}_transport` },
      create: {
        id: `pay_component_${code.toLowerCase()}_transport`,
        tenantId,
        name: 'Transport Allowance',
        type: 'allowance',
        amount: 15000,
      },
      update: {
        name: 'Transport Allowance',
        type: 'allowance',
        amount: 15000,
        deletedAt: null,
      },
    });

    await prisma.payComponent.upsert({
      where: { id: `pay_component_${code.toLowerCase()}_tax` },
      create: {
        id: `pay_component_${code.toLowerCase()}_tax`,
        tenantId,
        name: 'PAYE Deduction',
        type: 'deduction',
        amount: 5000,
      },
      update: {
        name: 'PAYE Deduction',
        type: 'deduction',
        amount: 5000,
        deletedAt: null,
      },
    });

    const month = new Date();
    month.setUTCDate(1);
    month.setUTCHours(0, 0, 0, 0);

    await prisma.payroll.upsert({
      where: { id: `payroll_${code.toLowerCase()}_001` },
      create: {
        id: `payroll_${code.toLowerCase()}_001`,
        tenantId,
        payrollGroupId: group.id,
        employeeName: `${code} Demo Employee`,
        grossPay: 120000,
        totalAllowance: 15000,
        totalDeduction: 5000,
        netPay: 130000,
        status: 'final',
        paymentStatus: 'due',
        payrollMonth: month,
      },
      update: {
        employeeName: `${code} Demo Employee`,
        grossPay: 120000,
        totalAllowance: 15000,
        totalDeduction: 5000,
        netPay: 130000,
        status: 'final',
        paymentStatus: 'due',
        payrollMonth: month,
        deletedAt: null,
      },
    });
  }

  console.log('HRM demo payroll / groups / components');
}
