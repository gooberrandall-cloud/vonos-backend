/**
 * One-time split: tenant_va_001 (VA) → tenant_vm_001 (VM) + tenant_vms_001 (VMS).
 * Reverses merge-vm-vms-into-va.ts using MigrationLegacyId offset and job reference prefixes.
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/split-va-into-vm-vms.ts --dry-run
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/split-va-into-vm-vms.ts
 */
import { Archetype, PrismaClient } from '@prisma/client';
import { catalogPresetsForCode } from '@vonos/types';

const VM_ID = 'tenant_vm_001';
const VMS_ID = 'tenant_vms_001';
const VA_ID = 'tenant_va_001';
const LEGACY_ID_OFFSET = 10_000_000;

const dryRun = process.argv.includes('--dry-run');

const mechanicsConfig = {
  tenantId: VM_ID,
  code: 'VM',
  name: 'Vonos Mechanics',
  archetype: 'job',
  navItems: [
    { label: 'Overview', icon: 'layout-dashboard', route: '/VM/overview', pageType: 'dashboard' },
    { label: 'Jobs', icon: 'wrench', route: '/VM/jobs', pageType: 'list' },
    { label: 'Vehicles', icon: 'car', route: '/VM/vehicles', pageType: 'list' },
    { label: 'Requisitions', icon: 'clipboard-list', route: '/VM/requisitions', pageType: 'list' },
    { label: 'Customers', icon: 'users', route: '/VM/customers', pageType: 'list' },
    { label: 'Reports', icon: 'pie-chart', route: '/VM/reports', pageType: 'dashboard' },
    { label: 'Finance', icon: 'wallet', route: '/VM/finance', pageType: 'dashboard' },
    { label: 'Users', icon: 'users', route: '/VM/users', pageType: 'form' },
    { label: 'Settings', icon: 'settings', route: '/VM/settings', pageType: 'form' },
  ],
  kpiCards: [
    { label: 'Open Jobs', icon: 'wrench', metricKey: 'openJobs', color: '#059669' },
    { label: 'In Shop', icon: 'car', metricKey: 'inShop', color: '#2563eb' },
    { label: 'Parts Pending', icon: 'package', metricKey: 'partsPending', color: '#9333ea' },
    { label: 'Revenue', icon: 'wallet', metricKey: 'revenue', color: '#e11d48' },
  ],
  terminology: {
    job: 'Job',
    vehicle: 'Vehicle',
    customer: 'Customer',
    requisition: 'Parts Requisition',
  },
  enabledModules: ['jobs', 'vehicles', 'requisitions', 'customers', 'reports', 'finance'],
};

const mechShopConfig = {
  tenantId: VMS_ID,
  code: 'VMS',
  name: 'Vonos Mech Shop',
  archetype: 'job',
  navItems: [
    { label: 'Overview', icon: 'layout-dashboard', route: '/VMS/overview', pageType: 'dashboard' },
    { label: 'Jobs', icon: 'wrench', route: '/VMS/jobs', pageType: 'list' },
    { label: 'Requisitions', icon: 'clipboard-list', route: '/VMS/requisitions', pageType: 'list' },
    { label: 'Customers', icon: 'users', route: '/VMS/customers', pageType: 'list' },
    { label: 'Reports', icon: 'pie-chart', route: '/VMS/reports', pageType: 'dashboard' },
    { label: 'Finance', icon: 'wallet', route: '/VMS/finance', pageType: 'dashboard' },
    { label: 'Users', icon: 'users', route: '/VMS/users', pageType: 'form' },
    { label: 'Settings', icon: 'settings', route: '/VMS/settings', pageType: 'form' },
  ],
  kpiCards: [
    { label: 'Active Jobs', icon: 'wrench', metricKey: 'activeJobs', color: '#059669' },
    { label: 'Completed', icon: 'check-circle', metricKey: 'completedJobs', color: '#2563eb' },
    { label: 'Pending QC', icon: 'shield-check', metricKey: 'pendingQc', color: '#9333ea' },
    { label: 'Revenue', icon: 'wallet', metricKey: 'revenue', color: '#e11d48' },
  ],
  terminology: {
    job: 'Job',
    customer: 'Customer',
    requisition: 'Material Requisition',
  },
  enabledModules: ['jobs', 'requisitions', 'customers', 'reports', 'finance'],
};

function withCatalog<T extends { code?: string }>(config: T) {
  return { ...config, ...catalogPresetsForCode(config.code) };
}

const TENANT_SCOPED_TABLES = [
  'Appointment',
  'Item',
  'StockMovement',
  'Supplier',
  'Job',
  'LedgerEntry',
  'Customer',
  'Sale',
  'MigrationLegacyId',
  'Vehicle',
  'Requisition',
  'SalonService',
  'CafeTable',
  'AuditLog',
  'PaymentAccount',
  'AccountTransaction',
  'Payment',
  'ProductCategory',
  'Brand',
  'ProductUnit',
  'Warranty',
  'SellingPriceGroup',
] as const;

async function countByTenant(prisma: PrismaClient, tenantId: string) {
  const [item, job, ledgerEntry, customer, migrationLegacyId, vehicle] = await Promise.all([
    prisma.item.count({ where: { tenantId } }),
    prisma.job.count({ where: { tenantId } }),
    prisma.ledgerEntry.count({ where: { tenantId } }),
    prisma.customer.count({ where: { tenantId } }),
    prisma.migrationLegacyId.count({ where: { tenantId } }),
    prisma.vehicle.count({ where: { tenantId } }),
  ]);
  return { Item: item, Job: job, LedgerEntry: ledgerEntry, Customer: customer, MigrationLegacyId: migrationLegacyId, Vehicle: vehicle };
}

function isVmsLegacyId(legacyId: number) {
  return legacyId >= LEGACY_ID_OFFSET;
}

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log(dryRun ? '=== DRY RUN ===' : '=== SPLIT VA → VM + VMS ===');

    const va = await prisma.tenant.findUnique({ where: { id: VA_ID } });
    if (!va || va.deletedAt) {
      console.log('VA tenant missing or already retired — split not needed.');
      const [vm, vms] = await Promise.all([
        prisma.tenant.findUnique({ where: { id: VM_ID } }),
        prisma.tenant.findUnique({ where: { id: VMS_ID } }),
      ]);
      if (vm && !vm.deletedAt) console.log('VM counts:', await countByTenant(prisma, VM_ID));
      if (vms && !vms.deletedAt) console.log('VMS counts:', await countByTenant(prisma, VMS_ID));
      return;
    }

    const vaCounts = await countByTenant(prisma, VA_ID);
    console.log('Preflight counts (VA):', vaCounts);

    const legacyMaps = await prisma.migrationLegacyId.findMany({
      where: { tenantId: VA_ID },
      select: { newId: true, legacyId: true, entityType: true },
    });

    const vmIds = new Set<string>();
    const vmsIds = new Set<string>();
    for (const row of legacyMaps) {
      if (isVmsLegacyId(row.legacyId)) vmsIds.add(row.newId);
      else vmIds.add(row.newId);
    }

    const [vmJobs, vmsJobs, otherJobs] = await Promise.all([
      prisma.job.count({ where: { tenantId: VA_ID, reference: { startsWith: 'VM-' } } }),
      prisma.job.count({ where: { tenantId: VA_ID, reference: { startsWith: 'VMS-' } } }),
      prisma.job.count({
        where: {
          tenantId: VA_ID,
          NOT: [{ reference: { startsWith: 'VM-' } }, { reference: { startsWith: 'VMS-' } }],
        },
      }),
    ]);

    console.log(
      `Legacy map — VM ids: ${vmIds.size}, VMS ids: ${vmsIds.size}; jobs VM-: ${vmJobs}, VMS-: ${vmsJobs}, other: ${otherJobs}`,
    );

    if (dryRun) {
      console.log('Dry run complete — no writes.');
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.tenant.upsert({
          where: { id: VM_ID },
          create: {
            id: VM_ID,
            code: 'VM',
            name: 'Vonos Mechanics',
            archetype: Archetype.job,
            config: withCatalog(mechanicsConfig),
          },
          update: {
            name: 'Vonos Mechanics',
            archetype: Archetype.job,
            config: withCatalog(mechanicsConfig),
            deletedAt: null,
          },
        });

        await tx.tenant.upsert({
          where: { id: VMS_ID },
          create: {
            id: VMS_ID,
            code: 'VMS',
            name: 'Vonos Mech Shop',
            archetype: Archetype.job,
            config: withCatalog(mechShopConfig),
          },
          update: {
            name: 'Vonos Mech Shop',
            archetype: Archetype.job,
            config: withCatalog(mechShopConfig),
            deletedAt: null,
          },
        });

        // Jobs first — reference prefix is authoritative for split side.
        const vmJobUpdate = await tx.job.updateMany({
          where: {
            tenantId: VA_ID,
            OR: [{ reference: { startsWith: 'VM-' } }, { reference: { not: { startsWith: 'VMS-' } } }],
          },
          data: { tenantId: VM_ID },
        });
        const vmsJobUpdate = await tx.job.updateMany({
          where: { tenantId: VA_ID, reference: { startsWith: 'VMS-' } },
          data: { tenantId: VMS_ID },
        });
        console.log(`Jobs → VM: ${vmJobUpdate.count}, VMS: ${vmsJobUpdate.count}`);

        // Strip merge collision prefixes.
        await tx.$executeRaw`
          UPDATE "Job"
          SET "reference" = SUBSTRING("reference" FROM 4)
          WHERE "tenantId" = ${VM_ID}
            AND "reference" LIKE 'VM-%'
        `;
        await tx.$executeRaw`
          UPDATE "Job"
          SET "reference" = SUBSTRING("reference" FROM 5)
          WHERE "tenantId" = ${VMS_ID}
            AND "reference" LIKE 'VMS-%'
        `;
        await tx.$executeRaw`
          UPDATE "Sale"
          SET "reference" = SUBSTRING("reference" FROM 5)
          WHERE "tenantId" IN (${VM_ID}, ${VMS_ID})
            AND "reference" LIKE 'VMS-%'
        `;
        await tx.$executeRaw`
          UPDATE "Sale"
          SET "reference" = SUBSTRING("reference" FROM 4)
          WHERE "tenantId" IN (${VM_ID}, ${VMS_ID})
            AND "reference" LIKE 'VM-%'
        `;
        await tx.$executeRaw`
          UPDATE "Requisition"
          SET "reference" = SUBSTRING("reference" FROM 5)
          WHERE "tenantId" IN (${VM_ID}, ${VMS_ID})
            AND "reference" LIKE 'VMS-%'
        `;
        await tx.$executeRaw`
          UPDATE "Vehicle"
          SET "plateNumber" = SUBSTRING("plateNumber" FROM 5)
          WHERE "tenantId" IN (${VM_ID}, ${VMS_ID})
            AND "plateNumber" LIKE 'VMS-%'
        `;

        const vmIdList = [...vmIds];
        const vmsIdList = [...vmsIds];

        const moveByIds = async (table: (typeof TENANT_SCOPED_TABLES)[number], ids: string[], targetId: string) => {
          if (ids.length === 0) return 0;
          const chunkSize = 5000;
          let total = 0;
          for (let i = 0; i < ids.length; i += chunkSize) {
            const chunk = ids.slice(i, i + chunkSize);
            const result = await tx.$executeRawUnsafe(
              `UPDATE "${table}" SET "tenantId" = $1 WHERE "tenantId" = $2 AND "id" = ANY($3::text[])`,
              targetId,
              VA_ID,
              chunk,
            );
            total += result;
          }
          return total;
        };

        for (const table of TENANT_SCOPED_TABLES) {
          if (table === 'Job' || table === 'MigrationLegacyId' || table === 'AuditLog') continue;
          const vmMoved = await moveByIds(table, vmIdList, VM_ID);
          const vmsMoved = await moveByIds(table, vmsIdList, VMS_ID);
          if (vmMoved > 0 || vmsMoved > 0) {
            console.log(`${table} → VM: ${vmMoved}, VMS: ${vmsMoved}`);
          }
        }

        const vmLegacy = await tx.$executeRaw`
          UPDATE "MigrationLegacyId"
          SET "tenantId" = ${VM_ID}
          WHERE "tenantId" = ${VA_ID} AND "legacyId" < ${LEGACY_ID_OFFSET}
        `;
        const vmsLegacy = await tx.$executeRaw`
          UPDATE "MigrationLegacyId"
          SET "tenantId" = ${VMS_ID}
          WHERE "tenantId" = ${VA_ID} AND "legacyId" >= ${LEGACY_ID_OFFSET}
        `;
        console.log(`MigrationLegacyId → VM: ${vmLegacy}, VMS: ${vmsLegacy}`);

        const vmAudit = await tx.$executeRaw`
          UPDATE "AuditLog"
          SET "tenantId" = ${VM_ID}
          WHERE "tenantId" = ${VA_ID}
            AND ("legacyLogId" IS NULL OR "legacyLogId" < ${LEGACY_ID_OFFSET})
        `;
        const vmsAudit = await tx.$executeRaw`
          UPDATE "AuditLog"
          SET "tenantId" = ${VMS_ID}
          WHERE "tenantId" = ${VA_ID} AND "legacyLogId" >= ${LEGACY_ID_OFFSET}
        `;
        console.log(`AuditLog → VM: ${vmAudit}, VMS: ${vmsAudit}`);

        await tx.$executeRaw`
          UPDATE "AccountTransaction" at
          SET "tenantId" = pa."tenantId"
          FROM "PaymentAccount" pa
          WHERE at."tenantId" = ${VA_ID} AND at."accountId" = pa."id"
        `;

        // Ledger rows linked to jobs on each side.
        await tx.$executeRaw`
          UPDATE "LedgerEntry" le
          SET "tenantId" = j."tenantId"
          FROM "Job" j
          WHERE le."tenantId" = ${VA_ID}
            AND le."linkedRecordType" = 'job'
            AND le."linkedRecordId" = j."id"
        `;
        await tx.$executeRaw`
          UPDATE "LedgerEntry" le
          SET "tenantId" = s."tenantId"
          FROM "Sale" s
          WHERE le."tenantId" = ${VA_ID}
            AND le."linkedRecordType" = 'sale'
            AND le."linkedRecordId" = s."id"
        `;
        await tx.$executeRaw`
          UPDATE "LedgerEntry" le
          SET "tenantId" = c."tenantId"
          FROM "Customer" c
          WHERE le."tenantId" = ${VA_ID}
            AND le."linkedRecordType" = 'customer'
            AND le."linkedRecordId" = c."id"
        `;

        // Remaining VA ledger → VM (quotation-heavy legacy default).
        const leftoverLedger = await tx.ledgerEntry.updateMany({
          where: { tenantId: VA_ID },
          data: { tenantId: VM_ID },
        });
        if (leftoverLedger.count > 0) {
          console.log(`LedgerEntry leftover → VM: ${leftoverLedger.count}`);
        }

        // Restore native VMS legacy IDs (undo merge offset).
        await tx.$executeRaw`
          UPDATE "MigrationLegacyId"
          SET "legacyId" = "legacyId" - ${LEGACY_ID_OFFSET}
          WHERE "tenantId" = ${VMS_ID}
            AND "legacyId" >= ${LEGACY_ID_OFFSET}
        `;
        await tx.$executeRaw`
          UPDATE "AuditLog"
          SET "legacyLogId" = "legacyLogId" - ${LEGACY_ID_OFFSET}
          WHERE "tenantId" = ${VMS_ID}
            AND "legacyLogId" IS NOT NULL
            AND "legacyLogId" >= ${LEGACY_ID_OFFSET}
        `;

        // Notifications + users
        await tx.notification.updateMany({
          where: { tenantId: VA_ID },
          data: { tenantId: VM_ID },
        });

        const vaAdmin = await tx.user.findFirst({
          where: { email: 'admin@va.vonos', tenantId: VA_ID },
        });
        if (vaAdmin) {
          await tx.user.upsert({
            where: { email: 'admin@vm.vonos' },
            create: {
              id: 'user_vm_admin',
              email: 'admin@vm.vonos',
              passwordHash: vaAdmin.passwordHash,
              name: 'Mechanics Admin',
              role: vaAdmin.role,
              status: vaAdmin.status,
              tenantId: VM_ID,
            },
            update: {
              name: 'Mechanics Admin',
              tenantId: VM_ID,
              role: vaAdmin.role,
              status: vaAdmin.status,
            },
          });
          await tx.user.upsert({
            where: { email: 'admin@vms.vonos' },
            create: {
              id: 'user_vms_admin',
              email: 'admin@vms.vonos',
              passwordHash: vaAdmin.passwordHash,
              name: 'Mech Shop Admin',
              role: vaAdmin.role,
              status: vaAdmin.status,
              tenantId: VMS_ID,
            },
            update: {
              name: 'Mech Shop Admin',
              tenantId: VMS_ID,
              role: vaAdmin.role,
              status: vaAdmin.status,
            },
          });
          await tx.user.update({
            where: { id: vaAdmin.id },
            data: { status: 'suspended', tenantId: null },
          });
        }

        const now = new Date();
        await tx.tenant.update({
          where: { id: VA_ID },
          data: { deletedAt: now },
        });
      },
      { timeout: 600_000 },
    );

    console.log('Postflight counts (VM):', await countByTenant(prisma, VM_ID));
    console.log('Postflight counts (VMS):', await countByTenant(prisma, VMS_ID));

    const leftover = await countByTenant(prisma, VA_ID);
    const leftoverTotal = Object.values(leftover).reduce((a, b) => a + b, 0);
    if (leftoverTotal > 0) {
      console.warn('Warning: rows still on VA:', leftover);
    }

    const activeTenants = await prisma.tenant.findMany({
      where: { code: { not: 'VAG' }, deletedAt: null },
      select: { code: true, name: true },
      orderBy: { code: 'asc' },
    });
    console.log('Active operating tenants:', activeTenants.map((t) => t.code).join(', '));
    console.log('Split complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
