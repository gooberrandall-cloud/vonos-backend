/**
 * Assign Employee designation + isServiceStaff from payroll group names.
 * Uses HRM payroll batches (e.g. TECHNICAL STAFF, BODYWORK AND PAINTING STAFF),
 * not legacy Ultimate POS is_service_staff roles.
 *
 * Usage (from apps/api):
 *   TENANT_CODE=VA npx ts-node --transpile-only prisma/scripts/assign-service-staff-from-payroll-groups.ts
 */
import { PrismaClient } from '@prisma/client';
import { isServiceStaffDesignation } from '../../src/common/utils/serviceStaffDesignations';

const prisma = new PrismaClient();
const tenantFilter = process.env.TENANT_CODE?.trim().toUpperCase();

function payrollGroupCategory(groupName: string): string {
  const match = groupName.match(/\(([^)]+)\)\s*$/);
  return (match?.[1] ?? groupName).trim().toUpperCase();
}

function designationForCategory(category: string): string | null {
  if (
    category.includes('BODY WORK') ||
    category.includes('BODYWORK') ||
    category.includes('PAINTING')
  ) {
    return 'Body Works / Panel Beater';
  }
  if (category.includes('ELECTRICIAN')) return 'AUTO-ELECTRICIAN';
  if (category.includes('TECHNICAL')) return 'TECHNICAL STAFF';
  if (category.includes('CLEANER')) return 'CLEANER';
  if (category.includes('WHEEL')) return 'Wheel Alignment Tech';
  if (category.includes('MECHANIC')) return 'AUTO-MECHANIC';
  if (category.includes('MANAGEMENT')) return 'Manager';
  if (category.includes('DOMESTIC')) return 'Domestic Driver';
  if (category.includes('SALES') || category.includes('FRONT DESK')) {
    return 'Sales Rep / Front Desk';
  }
  if (category.includes('SECURITY')) return 'Security';
  if (category.includes('ACCOUNT')) return 'Accountant';
  if (category.includes('STORE')) return 'Store Keeper';
  return null;
}

async function assignTenant(tenantId: string, tenantCode: string) {
  const designations = await prisma.designation.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true, name: true },
  });
  const designationByName = new Map(
    designations.map((row) => [row.name.toLowerCase(), row.id]),
  );
  const staffDesignationId =
    designationByName.get('staff') ??
    designations.find((row) => row.name === 'Staff')?.id;

  const payrollRows = await prisma.payroll.findMany({
    where: {
      tenantId,
      deletedAt: null,
      employeeRecordId: { not: null },
      payrollGroupId: { not: null },
    },
    select: {
      employeeRecordId: true,
      createdAt: true,
      payrollGroup: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const latestCategoryByEmployee = new Map<string, string>();
  for (const row of payrollRows) {
    const employeeId = row.employeeRecordId!;
    if (latestCategoryByEmployee.has(employeeId)) continue;
    const category = payrollGroupCategory(row.payrollGroup?.name ?? '');
    latestCategoryByEmployee.set(employeeId, category);
  }

  let designationUpdated = 0;
  let serviceStaffMarked = 0;
  let serviceStaffCleared = 0;

  for (const [employeeId, category] of latestCategoryByEmployee) {
    const designationName = designationForCategory(category);
    const designationId = designationName
      ? designationByName.get(designationName.toLowerCase()) ?? staffDesignationId
      : staffDesignationId;

    if (!designationId) continue;

    const shouldMark = designationName
      ? isServiceStaffDesignation(designationName)
      : false;

    const updated = await prisma.employee.updateMany({
      where: {
        id: employeeId,
        tenantId,
        deletedAt: null,
        OR: [
          { designationId: { not: designationId } },
          { isServiceStaff: { not: shouldMark } },
        ],
      },
      data: {
        designationId,
        isServiceStaff: shouldMark,
      },
    });

    if (updated.count === 0) continue;
    designationUpdated += updated.count;
    if (shouldMark) serviceStaffMarked += updated.count;
    else serviceStaffCleared += updated.count;
  }

  const totalServiceStaff = await prisma.employee.count({
    where: { tenantId, deletedAt: null, isServiceStaff: true },
  });

  console.log(
    `${tenantCode}: designation_updated=${designationUpdated}, service_staff_marked=${serviceStaffMarked}, cleared=${serviceStaffCleared}, total_service_staff=${totalServiceStaff}`,
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
    await assignTenant(tenant.id, tenant.code);
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
