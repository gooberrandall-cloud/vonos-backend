import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant-id='));
const tenantFilter = tenantArg?.split('=')[1];

const PLATE_REGEX = /\b([A-Z0-9]{2,4}-[A-Z0-9]{2,6})\b/i;

const KNOWN_MAKES = [
  'TOYOTA',
  'HONDA',
  'HYUNDAI',
  'LEXUS',
  'NISSAN',
  'KIA',
  'BENZ',
  'MERCEDES',
  'BMW',
  'FORD',
  'PEUGEOT',
  'VOLKSWAGEN',
  'MAZDA',
  'ACURA',
] as const;

function normalizePlate(value: string): string {
  return value.trim().toUpperCase();
}

function deriveVehicleInfo(customerName: string): {
  plate: string;
  make: string;
  model: string;
  ownerName: string;
} | null {
  const raw = customerName.trim();
  if (!raw) return null;
  const plateMatch = raw.match(PLATE_REGEX);
  if (!plateMatch) return null;

  const plate = normalizePlate(plateMatch[1]);
  const beforePlate = raw.slice(0, plateMatch.index).trim().replace(/\s+/g, ' ');
  const parts = beforePlate.split(' ').filter(Boolean);

  let make = 'Unknown';
  let model = 'Unknown';

  const makeIdx = parts.findIndex((part) =>
    KNOWN_MAKES.includes(part.replace('.', '').toUpperCase() as (typeof KNOWN_MAKES)[number]),
  );
  if (makeIdx >= 0) {
    make = parts[makeIdx].replace('.', '');
    model = parts.slice(makeIdx + 1).join(' ').replace(/^T\./i, '').trim() || 'Unknown';
  } else {
    const tPrefix = parts.find((p) => /^T\./i.test(p));
    if (tPrefix) {
      make = 'Toyota';
      model = tPrefix.replace(/^T\./i, '') || 'Unknown';
    } else if (parts.length > 0) {
      model = parts[parts.length - 1];
    }
  }

  const ownerName = (makeIdx > 0 ? parts.slice(0, makeIdx).join(' ') : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Walk-in Customer';

  return { plate, make, model, ownerName };
}

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      deletedAt: null,
      vehicleId: null,
      customerName: { not: null },
      ...(tenantFilter ? { tenantId: tenantFilter } : {}),
    },
    select: {
      id: true,
      tenantId: true,
      customerName: true,
    },
  });

  let scanned = 0;
  let parsed = 0;
  let vehiclesCreated = 0;
  let jobsLinked = 0;
  let skipped = 0;
  const vehicleByTenantPlate = new Map<string, { tenantId: string; plate: string; make: string; model: string; ownerName: string }>();

  for (const job of jobs) {
    scanned += 1;
    const info = deriveVehicleInfo(job.customerName ?? '');
    if (!info) {
      skipped += 1;
      continue;
    }
    parsed += 1;
    const key = `${job.tenantId}:${info.plate}`;
    if (!vehicleByTenantPlate.has(key)) {
      vehicleByTenantPlate.set(key, {
        tenantId: job.tenantId,
        plate: info.plate,
        make: info.make,
        model: info.model,
        ownerName: info.ownerName,
      });
    }
  }

  const candidateVehicles = [...vehicleByTenantPlate.values()];

  if (!dryRun && candidateVehicles.length > 0) {
    const beforeCount = await prisma.vehicle.count({
      where: {
        ...(tenantFilter ? { tenantId: tenantFilter } : {}),
        deletedAt: null,
      },
    });

    await prisma.vehicle.createMany({
      data: candidateVehicles.map((v) => ({
        tenantId: v.tenantId,
        plateNumber: v.plate,
        make: v.make,
        model: v.model,
        ownerName: v.ownerName,
      })),
      skipDuplicates: true,
    });

    const afterCount = await prisma.vehicle.count({
      where: {
        ...(tenantFilter ? { tenantId: tenantFilter } : {}),
        deletedAt: null,
      },
    });
    vehiclesCreated = Math.max(0, afterCount - beforeCount);

    const updated = await prisma.$executeRawUnsafe(
      `
      UPDATE "Job" j
      SET "vehicleId" = v.id
      FROM "Vehicle" v
      WHERE j."tenantId" = v."tenantId"
        AND j."vehicleId" IS NULL
        AND j."deletedAt" IS NULL
        AND j."customerName" IS NOT NULL
        AND UPPER(SUBSTRING(j."customerName" FROM '([A-Za-z0-9]{2,4}-[A-Za-z0-9]{2,6})')) = v."plateNumber"
        ${tenantFilter ? `AND j."tenantId" = '${tenantFilter}'` : ''}
      `,
    );
    jobsLinked = Number(updated);
  } else {
    vehiclesCreated = candidateVehicles.length;
    jobsLinked = parsed;
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        tenantFilter: tenantFilter ?? 'all',
        scanned,
        parsed,
        vehiclesCreated,
        jobsLinked,
        skipped,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
