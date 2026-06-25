/**
 * One-time merge: tenant_vm_001 (VM) + tenant_vms_001 (VMS) → tenant_va_001 (VA).
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/merge-vm-vms-into-va.ts
 *   npx ts-node ... merge-vm-vms-into-va.ts --dry-run
 */
import { Archetype, PrismaClient, Role } from '@prisma/client';
import { catalogPresetsForCode } from '@vonos/types';
import { automotiveConfig } from '../seed/tenants';

const VM_ID = 'tenant_vm_001';
const VMS_ID = 'tenant_vms_001';
const VA_ID = 'tenant_va_001';
const SOURCE_IDS = [VM_ID, VMS_ID] as const;
const LEGACY_ID_OFFSET = 10_000_000;

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  staff: 1,
  manager: 2,
  admin: 3,
  super_admin: 4,
};

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

const dryRun = process.argv.includes('--dry-run');

function withCatalog<T extends { code?: string }>(config: T) {
  return { ...config, ...catalogPresetsForCode(config.code) };
}

async function countByTenant(prisma: PrismaClient, tenantId: string) {
  const [
    appointment,
    item,
    stockMovement,
    supplier,
    job,
    ledgerEntry,
    customer,
    sale,
    migrationLegacyId,
    vehicle,
    requisition,
    auditLog,
    paymentAccount,
    users,
  ] = await Promise.all([
    prisma.appointment.count({ where: { tenantId } }),
    prisma.item.count({ where: { tenantId } }),
    prisma.stockMovement.count({ where: { tenantId } }),
    prisma.supplier.count({ where: { tenantId } }),
    prisma.job.count({ where: { tenantId } }),
    prisma.ledgerEntry.count({ where: { tenantId } }),
    prisma.customer.count({ where: { tenantId } }),
    prisma.sale.count({ where: { tenantId } }),
    prisma.migrationLegacyId.count({ where: { tenantId } }),
    prisma.vehicle.count({ where: { tenantId } }),
    prisma.requisition.count({ where: { tenantId } }),
    prisma.auditLog.count({ where: { tenantId } }),
    prisma.paymentAccount.count({ where: { tenantId } }),
    prisma.user.count({ where: { tenantId } }),
  ]);
  return {
    Appointment: appointment,
    Item: item,
    StockMovement: stockMovement,
    Supplier: supplier,
    Job: job,
    LedgerEntry: ledgerEntry,
    Customer: customer,
    Sale: sale,
    MigrationLegacyId: migrationLegacyId,
    Vehicle: vehicle,
    Requisition: requisition,
    AuditLog: auditLog,
    PaymentAccount: paymentAccount,
    User: users,
  };
}

async function findJobReferenceCollisions(prisma: PrismaClient) {
  const [vmRows, vmsRows] = await Promise.all([
    prisma.job.findMany({
      where: { tenantId: VM_ID, deletedAt: null },
      select: { reference: true },
    }),
    prisma.job.findMany({
      where: { tenantId: VMS_ID, deletedAt: null },
      select: { id: true, reference: true },
    }),
  ]);
  const vmRefs = new Set(vmRows.map((r) => r.reference));
  return vmsRows.filter((r) => vmRefs.has(r.reference));
}

async function findSaleReferenceCollisions(prisma: PrismaClient) {
  const [vmRows, vmsRows] = await Promise.all([
    prisma.sale.findMany({
      where: { tenantId: VM_ID, deletedAt: null },
      select: { reference: true },
    }),
    prisma.sale.findMany({
      where: { tenantId: VMS_ID, deletedAt: null },
      select: { id: true, reference: true },
    }),
  ]);
  const vmRefs = new Set(vmRows.map((r) => r.reference));
  return vmsRows.filter((r) => vmRefs.has(r.reference));
}

async function findRequisitionReferenceCollisions(prisma: PrismaClient) {
  const [vmRows, vmsRows] = await Promise.all([
    prisma.requisition.findMany({
      where: { tenantId: VM_ID, deletedAt: null },
      select: { reference: true },
    }),
    prisma.requisition.findMany({
      where: { tenantId: VMS_ID, deletedAt: null },
      select: { id: true, reference: true },
    }),
  ]);
  const vmRefs = new Set(vmRows.map((r) => r.reference));
  return vmsRows.filter((r) => vmRefs.has(r.reference));
}

async function findCafeTableLabelCollisions(prisma: PrismaClient) {
  const [vmLabels, vmsTables] = await Promise.all([
    prisma.cafeTable.findMany({
      where: { tenantId: VM_ID, deletedAt: null },
      select: { label: true },
    }),
    prisma.cafeTable.findMany({
      where: { tenantId: VMS_ID, deletedAt: null },
      select: { id: true, label: true },
    }),
  ]);
  const vmSet = new Set(vmLabels.map((t) => t.label));
  return vmsTables.filter((t) => vmSet.has(t.label));
}

async function findPlateCollisions(prisma: PrismaClient) {
  const [vmPlates, vmsVehicles] = await Promise.all([
    prisma.vehicle.findMany({
      where: { tenantId: VM_ID, deletedAt: null },
      select: { plateNumber: true },
    }),
    prisma.vehicle.findMany({
      where: { tenantId: VMS_ID, deletedAt: null },
      select: { id: true, plateNumber: true },
    }),
  ]);
  const vmSet = new Set(vmPlates.map((v) => v.plateNumber));
  return vmsVehicles.filter((v) => vmSet.has(v.plateNumber));
}

async function dedupeUsersByEmail(
  tx: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >,
) {
  const sourceUsers = await tx.user.findMany({
    where: { tenantId: { in: [...SOURCE_IDS] } },
    orderBy: { createdAt: 'asc' },
  });

  const byEmail = new Map<string, typeof sourceUsers>();
  for (const user of sourceUsers) {
    const key = user.email.toLowerCase();
    const group = byEmail.get(key) ?? [];
    group.push(user);
    byEmail.set(key, group);
  }

  let removed = 0;
  for (const [, group] of byEmail) {
    if (group.length < 2) continue;

    const keeper = group.reduce((best, current) =>
      ROLE_RANK[current.role] > ROLE_RANK[best.role] ? current : best,
    );

    for (const duplicate of group) {
      if (duplicate.id === keeper.id) continue;
      if (ROLE_RANK[duplicate.role] > ROLE_RANK[keeper.role]) {
        await tx.user.update({
          where: { id: keeper.id },
          data: { role: duplicate.role },
        });
      }
      await tx.user.delete({ where: { id: duplicate.id } });
      removed += 1;
    }
  }

  return { removed };
}

async function assertNoLeftoverRows(prisma: PrismaClient) {
  const [jobs, customers, ledger] = await Promise.all([
    prisma.job.count({ where: { tenantId: { in: [...SOURCE_IDS] } } }),
    prisma.customer.count({ where: { tenantId: { in: [...SOURCE_IDS] } } }),
    prisma.ledgerEntry.count({ where: { tenantId: { in: [...SOURCE_IDS] } } }),
  ]);
  const total = jobs + customers + ledger;
  if (total > 0) {
    throw new Error(`Postflight failed: ${total} scoped rows still on VM/VMS`);
  }
}

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log(dryRun ? '=== DRY RUN ===' : '=== MERGE VM + VMS → VA ===');

    const [vmTenant, vmsTenant, existingVa] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: VM_ID } }),
      prisma.tenant.findUnique({ where: { id: VMS_ID } }),
      prisma.tenant.findUnique({ where: { id: VA_ID } }),
    ]);

    const vmActive = vmTenant && !vmTenant.deletedAt;
    const vmsActive = vmsTenant && !vmsTenant.deletedAt;

    if (!vmActive && !vmsActive) {
      console.log('No active VM/VMS tenants — merge already complete or not needed.');
      if (existingVa) {
        const counts = await countByTenant(prisma, VA_ID);
        console.log('VA counts:', counts);
        const activeTenants = await prisma.tenant.count({
          where: { code: { not: 'VAG' }, deletedAt: null },
        });
        console.log(`Active operating tenants: ${activeTenants}`);
      }
      return;
    }

    console.log('Preflight counts (VM):', await countByTenant(prisma, VM_ID));
    console.log('Preflight counts (VMS):', await countByTenant(prisma, VMS_ID));

    const [jobCollisions, saleCollisions, reqCollisions, plateCollisions, tableCollisions] =
      await Promise.all([
        findJobReferenceCollisions(prisma),
        findSaleReferenceCollisions(prisma),
        findRequisitionReferenceCollisions(prisma),
        findPlateCollisions(prisma),
        findCafeTableLabelCollisions(prisma),
      ]);

    console.log(
      `Reference collisions — Job: ${jobCollisions.length}, Sale: ${saleCollisions.length}, Requisition: ${reqCollisions.length}`,
    );
    console.log(`Plate collisions (Vehicle): ${plateCollisions.length}`);
    console.log(`Label collisions (CafeTable): ${tableCollisions.length}`);

    if (dryRun) {
      console.log('Dry run complete — no writes.');
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        const maxLegacy = await tx.migrationLegacyId.aggregate({
          where: { tenantId: VMS_ID },
          _max: { legacyId: true },
        });
        if ((maxLegacy._max.legacyId ?? 0) < LEGACY_ID_OFFSET) {
          await tx.migrationLegacyId.updateMany({
            where: { tenantId: VMS_ID },
            data: { legacyId: { increment: LEGACY_ID_OFFSET } },
          });
        }
        await tx.$executeRaw`
          UPDATE "AuditLog"
          SET "legacyLogId" = "legacyLogId" + ${LEGACY_ID_OFFSET}
          WHERE "tenantId" = ${VMS_ID}
            AND "legacyLogId" IS NOT NULL
            AND "legacyLogId" < ${LEGACY_ID_OFFSET}
        `;

        for (const job of jobCollisions) {
          await tx.job.update({
            where: { id: job.id },
            data: { reference: `VMS-${job.reference}` },
          });
        }
        for (const sale of saleCollisions) {
          await tx.sale.update({
            where: { id: sale.id },
            data: { reference: `VMS-${sale.reference}` },
          });
        }
        for (const req of reqCollisions) {
          await tx.requisition.update({
            where: { id: req.id },
            data: { reference: `VMS-${req.reference}` },
          });
        }
        for (const vehicle of plateCollisions) {
          await tx.vehicle.update({
            where: { id: vehicle.id },
            data: { plateNumber: `VMS-${vehicle.plateNumber}` },
          });
        }
        for (const table of tableCollisions) {
          await tx.cafeTable.update({
            where: { id: table.id },
            data: { label: `VMS-${table.label}` },
          });
        }

        // 3. Ensure VA tenant exists
        const vaConfig = withCatalog(automotiveConfig);
        await tx.tenant.upsert({
          where: { id: VA_ID },
          create: {
            id: VA_ID,
            code: 'VA',
            name: 'Vonos Automotive',
            archetype: Archetype.job,
            config: vaConfig,
          },
          update: {
            name: 'Vonos Automotive',
            archetype: Archetype.job,
            config: vaConfig,
            deletedAt: null,
          },
        });

        // 4. Reassign all scoped rows
        for (const table of TENANT_SCOPED_TABLES) {
          const result = await tx.$executeRawUnsafe(
            `UPDATE "${table}" SET "tenantId" = $1 WHERE "tenantId" = ANY($2::text[])`,
            VA_ID,
            SOURCE_IDS,
          );
          console.log(`Updated ${table}: ${result} rows`);
        }

        await tx.notification.updateMany({
          where: { tenantId: { in: [...SOURCE_IDS] } },
          data: { tenantId: VA_ID },
        });

        const dedupe = await dedupeUsersByEmail(tx);
        console.log(`User dedupe removed: ${dedupe.removed}`);

        const userUpdate = await tx.user.updateMany({
          where: {
            tenantId: { in: [...SOURCE_IDS] },
            role: { not: 'super_admin' },
          },
          data: { tenantId: VA_ID },
        });
        console.log(`Reassigned users: ${userUpdate.count}`);

        // 6. Soft-delete retired tenants
        const now = new Date();
        await tx.tenant.updateMany({
          where: { id: { in: [...SOURCE_IDS] } },
          data: { deletedAt: now },
        });
      },
      { timeout: 600_000 },
    );

    console.log('Postflight counts (VA):', await countByTenant(prisma, VA_ID));

    const activeTenants = await prisma.tenant.findMany({
      where: { code: { not: 'VAG' }, deletedAt: null },
      select: { code: true, name: true },
      orderBy: { code: 'asc' },
    });
    console.log(
      'Active operating tenants:',
      activeTenants.map((t) => t.code).join(', '),
    );

    await assertNoLeftoverRows(prisma);
    console.log('Merge complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
