/**
 * Seed Designation rows for Vonos Automotive (VA) from the legacy HQ export.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/seed-designations-va.ts
 *   TENANT_CODE=VA npx ts-node --transpile-only prisma/scripts/seed-designations-va.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const tenantCode = (process.env.TENANT_CODE ?? 'VA').trim().toUpperCase();

/** Unique designations from "Designations - Vonos Autos HQ.csv" (Office Assistant deduped). */
const DESIGNATIONS = [
  'Manager',
  'Sales Rep / Front Desk',
  'Painter',
  'Body Works / Panel Beater',
  'Store Keeper',
  'Accountant',
  'Security',
  'AUTO-MECHANIC',
  'AUTO-ELECTRICIAN',
  'HR MANAGER',
  'CLEANER',
  'TECHNICAL STAFF',
  'Operations Manager',
  'Quality Control Officer',
  'Office Assistant',
  'Domestic Driver',
  'Social Media Manager',
  'Wheel Alignment Tech',
  'Assistant Manager',
  'Head Of Training',
] as const;

async function main() {
  const tenant = await prisma.tenant.findFirst({
    where: { code: tenantCode, deletedAt: null },
    select: { id: true, code: true, name: true },
  });
  if (!tenant) {
    throw new Error(`Tenant ${tenantCode} not found`);
  }

  let created = 0;
  let existed = 0;

  for (const name of DESIGNATIONS) {
    const existing = await prisma.designation.findFirst({
      where: {
        tenantId: tenant.id,
        deletedAt: null,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (existing) {
      existed += 1;
      continue;
    }
    await prisma.designation.create({
      data: { tenantId: tenant.id, name },
    });
    created += 1;
  }

  console.log(
    `Designations for ${tenant.code} (${tenant.name}): created=${created}, already_present=${existed}, total_listed=${DESIGNATIONS.length}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
