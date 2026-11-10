/**
 * Backfill Employee (+ default Designation) rows from migrated Payroll data.
 *
 * Migration imported payroll runs with employeeName/employeeId strings but never
 * created Employee records — so HRM payroll dropdowns stay empty.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/backfill-employees-from-payroll.ts
 *   TENANT_CODE=VA npx ts-node --transpile-only prisma/scripts/backfill-employees-from-payroll.ts
 */
import { PrismaClient } from "@prisma/client";
import { isServiceStaffDesignation } from "../../src/common/utils/serviceStaffDesignations";

const prisma = new PrismaClient();
const tenantFilter = process.env.TENANT_CODE?.trim().toUpperCase();

function isLegacyPlaceholder(name: string): boolean {
  return /^Legacy payroll #/i.test(name.trim());
}

async function ensureStaffDesignation(tenantId: string): Promise<string> {
  const existing = await prisma.designation.findFirst({
    where: { tenantId, deletedAt: null, name: { equals: "Staff", mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.designation.create({
    data: {
      tenantId,
      name: "Staff",
    },
    select: { id: true },
  });
  return created.id;
}

async function backfillTenant(tenant: { id: string; code: string }) {
  const designationId = await ensureStaffDesignation(tenant.id);

  const distinct = await prisma.$queryRawUnsafe<
    Array<{
      employeeName: string;
      employeeId: string | null;
      payrollGroupId: string | null;
      locationCode: string | null;
      designationId: string | null;
    }>
  >(
    `
    SELECT DISTINCT ON (COALESCE(NULLIF(TRIM("employeeId"), ''), LOWER(TRIM("employeeName"))))
      TRIM("employeeName") AS "employeeName",
      NULLIF(TRIM("employeeId"), '') AS "employeeId",
      "payrollGroupId",
      "locationCode",
      "designationId"
    FROM "Payroll"
    WHERE "tenantId" = $1
      AND "deletedAt" IS NULL
      AND "employeeName" IS NOT NULL
      AND TRIM("employeeName") <> ''
    ORDER BY COALESCE(NULLIF(TRIM("employeeId"), ''), LOWER(TRIM("employeeName"))),
             "createdAt" DESC
    `,
    tenant.id,
  );

  const usable = distinct.filter((row) => !isLegacyPlaceholder(row.employeeName));
  let created = 0;
  let linked = 0;
  let skipped = distinct.length - usable.length;

  for (const row of usable) {
    const code = row.employeeId;
    let employee = code
      ? await prisma.employee.findFirst({
          where: {
            tenantId: tenant.id,
            deletedAt: null,
            employeeCode: code,
          },
        })
      : null;

    if (!employee) {
      employee = await prisma.employee.findFirst({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          name: { equals: row.employeeName, mode: "insensitive" },
          ...(code ? {} : { employeeCode: null }),
        },
      });
    }

    if (!employee) {
      const resolvedDesignationId = row.designationId ?? designationId;
      const designation = await prisma.designation.findFirst({
        where: { id: resolvedDesignationId, tenantId: tenant.id },
        select: { name: true },
      });
      employee = await prisma.employee.create({
        data: {
          tenantId: tenant.id,
          name: row.employeeName,
          employeeCode: code,
          locationCode: row.locationCode,
          payrollGroupId: row.payrollGroupId,
          designationId: resolvedDesignationId,
          isServiceStaff: isServiceStaffDesignation(designation?.name),
        },
      });
      created += 1;
    }

    const updated = await prisma.payroll.updateMany({
      where: {
        tenantId: tenant.id,
        deletedAt: null,
        employeeRecordId: null,
        ...(code
          ? { employeeId: code }
          : { employeeName: { equals: row.employeeName, mode: "insensitive" } }),
      },
      data: {
        employeeRecordId: employee.id,
        designationId: employee.designationId,
        payrollGroupId: employee.payrollGroupId ?? row.payrollGroupId,
        locationCode: employee.locationCode ?? row.locationCode,
      },
    });
    linked += updated.count;
  }

  return { created, linked, skipped, candidates: usable.length };
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: tenantFilter ? { code: tenantFilter } : undefined,
    select: { id: true, code: true },
    orderBy: { code: "asc" },
  });

  if (tenants.length === 0) {
    console.error(
      tenantFilter
        ? `No tenant found for TENANT_CODE=${tenantFilter}`
        : "No tenants found",
    );
    process.exit(1);
  }

  console.log(
    `Backfilling employees from payroll for ${tenants.length} tenant(s)…`,
  );

  for (const tenant of tenants) {
    const result = await backfillTenant(tenant);
    console.log(
      `${tenant.code}: created ${result.created} employees from ${result.candidates} names, linked ${result.linked} payrolls` +
        (result.skipped ? `, skipped ${result.skipped} legacy placeholders` : ""),
    );
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
