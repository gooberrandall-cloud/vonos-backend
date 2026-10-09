/**
 * Mark Employee.isServiceStaff from designation names (workshop / technical roles).
 * Does NOT import legacy Ultimate POS `is_service_staff` roles or sell-line staff ids.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/mark-service-staff-from-designations.ts
 *   TENANT_CODE=VA npx ts-node --transpile-only prisma/scripts/mark-service-staff-from-designations.ts
 */
import { PrismaClient } from '@prisma/client';
import { isServiceStaffDesignation } from '../../src/common/utils/serviceStaffDesignations';

const prisma = new PrismaClient();
const tenantFilter = process.env.TENANT_CODE?.trim().toUpperCase();

async function markTenant(tenantId: string, tenantCode: string) {
  // 1) Align employee designation from latest payroll row (richer than generic "Staff").
  const payrollRows = await prisma.payroll.findMany({
    where: {
      tenantId,
      deletedAt: null,
      employeeRecordId: { not: null },
      designationId: { not: null },
    },
    select: { employeeRecordId: true, designationId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  const latestDesignationByEmployee = new Map<string, string>();
  for (const row of payrollRows) {
    const employeeId = row.employeeRecordId!;
    if (!latestDesignationByEmployee.has(employeeId)) {
      latestDesignationByEmployee.set(employeeId, row.designationId!);
    }
  }

  let designationSynced = 0;
  for (const [employeeId, designationId] of latestDesignationByEmployee) {
    const updated = await prisma.employee.updateMany({
      where: {
        id: employeeId,
        tenantId,
        deletedAt: null,
        NOT: { designationId },
      },
      data: { designationId },
    });
    designationSynced += updated.count;
  }

  // 2) Set isServiceStaff from designation name.
  const employees = await prisma.employee.findMany({
    where: { tenantId, deletedAt: null },
    select: {
      id: true,
      isServiceStaff: true,
      designation: { select: { name: true } },
    },
  });

  let marked = 0;
  let cleared = 0;
  for (const employee of employees) {
    const shouldMark = isServiceStaffDesignation(employee.designation.name);
    if (employee.isServiceStaff === shouldMark) continue;
    await prisma.employee.update({
      where: { id: employee.id },
      data: { isServiceStaff: shouldMark },
    });
    if (shouldMark) marked += 1;
    else cleared += 1;
  }

  console.log(
    `${tenantCode}: designation_synced=${designationSynced}, service_staff=${marked}, cleared=${cleared}`,
  );
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: tenantFilter ? { code: tenantFilter } : undefined,
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });

  if (tenants.length === 0) {
    throw new Error(
      tenantFilter
        ? `No tenant found for TENANT_CODE=${tenantFilter}`
        : 'No tenants found',
    );
  }

  for (const tenant of tenants) {
    await markTenant(tenant.id, tenant.code);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
