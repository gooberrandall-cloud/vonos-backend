/**
 * Clone VA service-staff employees (+ required designations) into
 * VISP / VSP / VW / VP so the sale "Service staff" picker is the same
 * catalog across group tenants. Soft-deletes service staff on VC.
 *
 * Does NOT clone userId / payrollGroupId (tenant-local links).
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/sync-group-service-staff.ts
 *   npx ts-node --transpile-only prisma/scripts/sync-group-service-staff.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

const SOURCE = 'VA';
const KEEP = ['VA', 'VISP', 'VSP', 'VW', 'VP'] as const;
const REMOVE_FROM = 'VC';

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function staffKey(name: string, employeeCode: string | null): string {
  const code = (employeeCode ?? '').trim().toLowerCase();
  return code ? `code:${code}` : `name:${nameKey(name)}`;
}

async function ensureDesignation(
  tenantId: string,
  source: { name: string; description: string | null },
  cache: Map<string, string>,
): Promise<string> {
  const key = nameKey(source.name);
  const hit = cache.get(key);
  if (hit) return hit;

  const existing = await prisma.designation.findFirst({
    where: { tenantId, deletedAt: null, name: { equals: source.name, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existing) {
    cache.set(key, existing.id);
    return existing.id;
  }

  if (dryRun) {
    const fake = `dryrun-desig-${key}`;
    cache.set(key, fake);
    return fake;
  }

  const created = await prisma.designation.create({
    data: {
      tenantId,
      name: source.name,
      description: source.description,
    },
    select: { id: true },
  });
  cache.set(key, created.id);
  return created.id;
}

async function syncTenant(
  sourceId: string,
  targetId: string,
  targetCode: string,
  sourceStaff: Array<{
    name: string;
    employeeCode: string | null;
    locationCode: string | null;
    locationCodes: string[];
    isServiceStaff: boolean;
    accountHolderName: string | null;
    bankName: string | null;
    bankBranch: string | null;
    bankCode: string | null;
    bankAccountNo: string | null;
    taxPayerId: string | null;
    designation: { name: string; description: string | null };
  }>,
) {
  const existing = await prisma.employee.findMany({
    where: { tenantId: targetId, deletedAt: null, isServiceStaff: true },
    select: { id: true, name: true, employeeCode: true },
  });
  const byKey = new Map(
    existing.map((e) => [staffKey(e.name, e.employeeCode), e.id]),
  );

  const desigCache = new Map<string, string>();
  let created = 0;
  let skipped = 0;

  for (const row of sourceStaff) {
    const key = staffKey(row.name, row.employeeCode);
    if (byKey.has(key)) {
      skipped += 1;
      continue;
    }

    const designationId = await ensureDesignation(
      targetId,
      row.designation,
      desigCache,
    );

    if (!dryRun) {
      await prisma.employee.create({
        data: {
          tenantId: targetId,
          name: row.name,
          employeeCode: row.employeeCode,
          locationCode: row.locationCode,
          locationCodes: row.locationCodes,
          designationId,
          isServiceStaff: true,
          accountHolderName: row.accountHolderName,
          bankName: row.bankName,
          bankBranch: row.bankBranch,
          bankCode: row.bankCode,
          bankAccountNo: row.bankAccountNo,
          taxPayerId: row.taxPayerId,
          // Keep payroll/user links tenant-local — not cloned.
          payrollGroupId: null,
          userId: null,
        },
      });
    }
    byKey.set(key, 'new');
    created += 1;
  }

  return {
    tenant: targetCode,
    source: sourceStaff.length,
    created,
    skipped,
    totalServiceStaff: byKey.size,
  };
}

async function softDeleteVc(tenantId: string) {
  if (dryRun) {
    const n = await prisma.employee.count({
      where: { tenantId, deletedAt: null, isServiceStaff: true },
    });
    return { tenant: REMOVE_FROM, softDeleted: n };
  }
  const result = await prisma.employee.updateMany({
    where: { tenantId, deletedAt: null, isServiceStaff: true },
    data: { deletedAt: new Date() },
  });
  return { tenant: REMOVE_FROM, softDeleted: result.count };
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: { code: { in: [...KEEP, REMOVE_FROM] } },
    select: { id: true, code: true },
  });
  const byCode = new Map(tenants.map((t) => [t.code, t]));
  const source = byCode.get(SOURCE);
  if (!source) throw new Error(`Missing source tenant ${SOURCE}`);

  const sourceStaff = await prisma.employee.findMany({
    where: { tenantId: source.id, deletedAt: null, isServiceStaff: true },
    include: {
      designation: { select: { name: true, description: true } },
    },
    orderBy: { name: 'asc' },
  });

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Cloning ${sourceStaff.length} VA service staff → ${KEEP.filter((c) => c !== SOURCE).join(', ')}`,
  );

  for (const code of KEEP) {
    if (code === SOURCE) {
      console.log(
        JSON.stringify({
          tenant: code,
          source: sourceStaff.length,
          created: 0,
          skipped: sourceStaff.length,
          totalServiceStaff: sourceStaff.length,
        }),
      );
      continue;
    }
    const target = byCode.get(code);
    if (!target) throw new Error(`Missing tenant ${code}`);
    const result = await syncTenant(
      source.id,
      target.id,
      code,
      sourceStaff,
    );
    console.log(JSON.stringify(result));
  }

  const vc = byCode.get(REMOVE_FROM);
  if (vc) {
    console.log(JSON.stringify(await softDeleteVc(vc.id)));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
