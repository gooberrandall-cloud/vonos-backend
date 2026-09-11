import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

const VA = 'tenant_va_001';

const DRYRUN_TARGETS = {
  jobs: 16523,
  payrollGroups: 196,
  payComponents: 4,
  payrolls: 1910,
} as const;

function loadDryRunTargets() {
  try {
    const path = join(__dirname, '../../../docs/migration-audits/dryruns/VA_MIGRATION_DRYRUN.json');
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { counts?: Record<string, number> };
    return raw.counts ?? DRYRUN_TARGETS;
  } catch {
    return DRYRUN_TARGETS;
  }
}

async function main() {
  const p = new PrismaClient();

  const tenants = await p.$queryRawUnsafe(`
    SELECT id, code, name, archetype::text, "deletedAt"
    FROM "Tenant"
    WHERE code IN ('VA','VM','VMS','VW','VISP','VSP','VC','VKW','VS','VAG')
    ORDER BY code
  `);

  const counts = await p.$queryRawUnsafe(`
    SELECT 'Job' AS entity, "tenantId", COUNT(*)::int AS cnt FROM "Job" GROUP BY "tenantId"
    UNION ALL SELECT 'Customer', "tenantId", COUNT(*)::int FROM "Customer" GROUP BY "tenantId"
    UNION ALL SELECT 'Item', "tenantId", COUNT(*)::int FROM "Item" GROUP BY "tenantId"
    UNION ALL SELECT 'LedgerEntry', "tenantId", COUNT(*)::int FROM "LedgerEntry" GROUP BY "tenantId"
    UNION ALL SELECT 'Supplier', "tenantId", COUNT(*)::int FROM "Supplier" GROUP BY "tenantId"
    UNION ALL SELECT 'MigrationLegacyId', "tenantId", COUNT(*)::int FROM "MigrationLegacyId" GROUP BY "tenantId"
    UNION ALL SELECT 'AuditLog', "tenantId", COUNT(*)::int FROM "AuditLog" GROUP BY "tenantId"
    UNION ALL SELECT 'PaymentAccount', "tenantId", COUNT(*)::int FROM "PaymentAccount" GROUP BY "tenantId"
    UNION ALL SELECT 'AccountTransaction', "tenantId", COUNT(*)::int FROM "AccountTransaction" GROUP BY "tenantId"
    UNION ALL SELECT 'Payment', "tenantId", COUNT(*)::int FROM "Payment" GROUP BY "tenantId"
    UNION ALL SELECT 'User', "tenantId", COUNT(*)::int FROM "User" GROUP BY "tenantId"
    UNION ALL SELECT 'PayrollGroup', "tenantId", COUNT(*)::int FROM "PayrollGroup" GROUP BY "tenantId"
    UNION ALL SELECT 'PayComponent', "tenantId", COUNT(*)::int FROM "PayComponent" GROUP BY "tenantId"
    UNION ALL SELECT 'Payroll', "tenantId", COUNT(*)::int FROM "Payroll" GROUP BY "tenantId"
    UNION ALL SELECT 'Expense', "tenantId", COUNT(*)::int FROM "Expense" GROUP BY "tenantId"
    ORDER BY entity, "tenantId"
  `);

  const jobSources = await p.$queryRawUnsafe(`
    SELECT CASE
      WHEN reference LIKE 'VM-%' THEN 'VM (Quotation)'
      WHEN reference LIKE 'VMS-%' THEN 'VMS (OPS)'
      ELSE 'other'
    END AS source, COUNT(*)::int AS job_count
    FROM "Job"
    WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
    GROUP BY 1 ORDER BY 1
  `);

  const legacyNs = await p.$queryRawUnsafe(`
    SELECT CASE WHEN "legacyId" >= 10000000 THEN 'vms_offset' ELSE 'vm_original' END AS ns,
           COUNT(*)::int AS cnt
    FROM "MigrationLegacyId" WHERE "tenantId" = '${VA}' GROUP BY 1
  `);

  const legacyTypes = await p.$queryRawUnsafe(`
    SELECT "entityType", COUNT(*)::int AS cnt
    FROM "MigrationLegacyId" WHERE "tenantId" = '${VA}'
    GROUP BY "entityType" ORDER BY cnt DESC LIMIT 12
  `);

  const ledger = await p.$queryRawUnsafe(`
    SELECT type::text, COUNT(*)::int AS cnt, SUM(amount)::text AS total_amount
    FROM "LedgerEntry"
    WHERE "tenantId" = '${VA}' AND "deletedAt" IS NULL
    GROUP BY type ORDER BY type
  `);

  const columns = await p.$queryRawUnsafe(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('Tenant','Job','JobMaterial','JobLabour','Customer','Item','LedgerEntry','MigrationLegacyId','AuditLog','PaymentAccount','User')
    ORDER BY table_name, ordinal_position
  `);

  const samples = await p.$queryRawUnsafe(`
    SELECT 'job_vm' AS label, row_to_json(t) AS row FROM (
      SELECT id, "tenantId", reference, status, "customerName", "hasQuote", "quoteAmount", "locationCode", "createdByName", "dueDate"
      FROM "Job" WHERE "tenantId"='${VA}' AND reference LIKE 'VM-%' LIMIT 1
    ) t
    UNION ALL SELECT 'job_vms', row_to_json(t) FROM (
      SELECT id, "tenantId", reference, status, "customerName", "locationCode", "createdByName"
      FROM "Job" WHERE "tenantId"='${VA}' AND reference LIKE 'VMS-%' LIMIT 1
    ) t
    UNION ALL SELECT 'job_material', row_to_json(t) FROM (
      SELECT jm.id, jm."jobId", jm."itemId", jm.name, jm.quantity, jm."unitCost", jm."totalCost", jm.source
      FROM "JobMaterial" jm JOIN "Job" j ON j.id = jm."jobId"
      WHERE j."tenantId"='${VA}' LIMIT 1
    ) t
    UNION ALL SELECT 'customer', row_to_json(t) FROM (
      SELECT id, "tenantId", name, email, phone FROM "Customer" WHERE "tenantId"='${VA}' LIMIT 1
    ) t
    UNION ALL SELECT 'item', row_to_json(t) FROM (
      SELECT id, "tenantId", sku, name, category, quantity, "costPrice", currency, status::text
      FROM "Item" WHERE "tenantId"='${VA}' LIMIT 1
    ) t
    UNION ALL SELECT 'ledger', row_to_json(t) FROM (
      SELECT id, type::text, amount, currency, category, description, date
      FROM "LedgerEntry" WHERE "tenantId"='${VA}' LIMIT 1
    ) t
    UNION ALL SELECT 'legacy_vm', row_to_json(t) FROM (
      SELECT "entityType", "legacyId", "newId" FROM "MigrationLegacyId"
      WHERE "tenantId"='${VA}' AND "legacyId" < 10000000 LIMIT 1
    ) t
    UNION ALL SELECT 'legacy_vms', row_to_json(t) FROM (
      SELECT "entityType", "legacyId", "newId" FROM "MigrationLegacyId"
      WHERE "tenantId"='${VA}' AND "legacyId" >= 10000000 LIMIT 1
    ) t
  `);

  const leftover = await p.$queryRawUnsafe(`
    SELECT 'Job' AS entity, COUNT(*)::int AS leftover
    FROM "Job" WHERE "tenantId" IN ('tenant_vm_001','tenant_vms_001')
    UNION ALL SELECT 'Customer', COUNT(*)::int FROM "Customer" WHERE "tenantId" IN ('tenant_vm_001','tenant_vms_001')
    UNION ALL SELECT 'Item', COUNT(*)::int FROM "Item" WHERE "tenantId" IN ('tenant_vm_001','tenant_vms_001')
    UNION ALL SELECT 'LedgerEntry', COUNT(*)::int FROM "LedgerEntry" WHERE "tenantId" IN ('tenant_vm_001','tenant_vms_001')
  `);

  const jobStatus = await p.$queryRawUnsafe(`
    SELECT status, COUNT(*)::int AS cnt
    FROM "Job" WHERE "tenantId"='${VA}' AND "deletedAt" IS NULL
    GROUP BY status ORDER BY cnt DESC
  `);

  const hrmCounts = await p.$queryRawUnsafe(`
    SELECT
      (SELECT COUNT(*)::int FROM "PayrollGroup" WHERE "tenantId"='${VA}') AS payroll_groups,
      (SELECT COUNT(*)::int FROM "PayComponent" WHERE "tenantId"='${VA}') AS pay_components,
      (SELECT COUNT(*)::int FROM "Payroll" WHERE "tenantId"='${VA}') AS payrolls,
      (SELECT COUNT(*)::int FROM "Expense" WHERE "tenantId"='${VA}') AS expenses
  `);

  const targets = loadDryRunTargets();
  const vaJobCount = await p.job.count({ where: { tenantId: VA, deletedAt: null } });
  const hrm = (hrmCounts as Array<Record<string, number>>)[0] ?? {};

  const verification = {
    jobs: { actual: vaJobCount, target: targets.jobs ?? DRYRUN_TARGETS.jobs, pass: vaJobCount >= (targets.jobs ?? DRYRUN_TARGETS.jobs) * 0.99 },
    payrollGroups: { actual: hrm.payroll_groups ?? 0, target: targets.payrollGroups ?? DRYRUN_TARGETS.payrollGroups, pass: (hrm.payroll_groups ?? 0) === (targets.payrollGroups ?? DRYRUN_TARGETS.payrollGroups) },
    payComponents: { actual: hrm.pay_components ?? 0, target: targets.payComponents ?? DRYRUN_TARGETS.payComponents, pass: (hrm.pay_components ?? 0) === (targets.payComponents ?? DRYRUN_TARGETS.payComponents) },
    payrolls: { actual: hrm.payrolls ?? 0, target: targets.payrolls ?? DRYRUN_TARGETS.payrolls, pass: (hrm.payrolls ?? 0) === (targets.payrolls ?? DRYRUN_TARGETS.payrolls) },
  };

  console.log(JSON.stringify({
    tenants,
    counts,
    jobSources,
    jobStatus,
    hrmCounts,
    verification,
    legacyNs,
    legacyTypes,
    ledger,
    leftover,
    samples,
    columns,
  }, null, 2));

  await p.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
