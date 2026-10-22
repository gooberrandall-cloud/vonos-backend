/**
 * Clone VA payment accounts, expense categories, product categories, brands,
 * product units, designations, and invoice schemes into other operating
 * tenants that are missing matching rows (by name).
 *
 * Does NOT clone suppliers/customers/employees/payroll (tenant-specific) or
 * transaction history — each tenant gets local IDs for pickers/FK writes.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/clone-va-master-data.ts
 *   TENANT_CODE=VP npx ts-node --transpile-only prisma/scripts/clone-va-master-data.ts
 *   npx ts-node --transpile-only prisma/scripts/clone-va-master-data.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const onlyCode = (process.env.TENANT_CODE ?? '').trim().toUpperCase();
const SOURCE_CODE = 'VA';

const OPERATING = [
  'VA',
  'VW',
  'VISP',
  'VSP',
  'VP',
  'VC',
  'VS',
  'VKW',
] as const;

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

async function clonePaymentAccounts(sourceId: string, targetId: string) {
  const source = await prisma.paymentAccount.findMany({
    where: { tenantId: sourceId, deletedAt: null },
  });
  const existing = await prisma.paymentAccount.findMany({
    where: { tenantId: targetId, deletedAt: null },
    select: { name: true, accountNumber: true },
  });
  const byName = new Set(existing.map((r) => nameKey(r.name)));
  const byNumber = new Set(
    existing
      .map((r) => r.accountNumber.trim().toLowerCase())
      .filter(Boolean),
  );

  let created = 0;
  let skipped = 0;
  for (const row of source) {
    const n = nameKey(row.name);
    const num = row.accountNumber.trim().toLowerCase();
    if (byName.has(n) || (num && byNumber.has(num))) {
      skipped += 1;
      continue;
    }
    if (!dryRun) {
      await prisma.paymentAccount.create({
        data: {
          tenantId: targetId,
          name: row.name,
          accountNumber: row.accountNumber,
          accountType: row.accountType,
          accountSubType: row.accountSubType,
          accountDetails: row.accountDetails,
          note: row.note
            ? `${row.note} (cloned from VA)`
            : 'Cloned from VA',
          isClosed: row.isClosed,
          currency: row.currency,
          createdByName: 'system:clone-va-master-data',
        },
      });
    }
    byName.add(n);
    if (num) byNumber.add(num);
    created += 1;
  }
  return { created, skipped, source: source.length };
}

async function cloneExpenseCategories(sourceId: string, targetId: string) {
  const source = await prisma.expenseCategory.findMany({
    where: { tenantId: sourceId, deletedAt: null },
  });
  const existing = await prisma.expenseCategory.findMany({
    where: { tenantId: targetId, deletedAt: null },
    select: { name: true },
  });
  const byName = new Set(existing.map((r) => nameKey(r.name)));

  let created = 0;
  let skipped = 0;
  for (const row of source) {
    if (byName.has(nameKey(row.name))) {
      skipped += 1;
      continue;
    }
    if (!dryRun) {
      await prisma.expenseCategory.create({
        data: {
          tenantId: targetId,
          name: row.name,
          code: row.code,
        },
      });
    }
    byName.add(nameKey(row.name));
    created += 1;
  }
  return { created, skipped, source: source.length };
}

async function cloneProductCategories(sourceId: string, targetId: string) {
  const source = await prisma.productCategory.findMany({
    where: { tenantId: sourceId, deletedAt: null },
  });
  const existing = await prisma.productCategory.findMany({
    where: { tenantId: targetId, deletedAt: null },
    select: { name: true },
  });
  const byName = new Set(existing.map((r) => nameKey(r.name)));

  let created = 0;
  let skipped = 0;
  for (const row of source) {
    if (byName.has(nameKey(row.name))) {
      skipped += 1;
      continue;
    }
    if (!dryRun) {
      await prisma.productCategory.create({
        data: {
          tenantId: targetId,
          name: row.name,
          shortCode: row.shortCode,
          categoryType: row.categoryType,
          description: row.description,
          slug: row.slug,
          // parent links stay local; skip parentId to avoid cross-tenant FKs
          parentId: null,
        },
      });
    }
    byName.add(nameKey(row.name));
    created += 1;
  }
  return { created, skipped, source: source.length };
}

async function cloneBrands(sourceId: string, targetId: string) {
  const source = await prisma.brand.findMany({
    where: { tenantId: sourceId, deletedAt: null },
  });
  const existing = await prisma.brand.findMany({
    where: { tenantId: targetId, deletedAt: null },
    select: { name: true },
  });
  const byName = new Set(existing.map((r) => nameKey(r.name)));

  let created = 0;
  let skipped = 0;
  for (const row of source) {
    if (byName.has(nameKey(row.name))) {
      skipped += 1;
      continue;
    }
    if (!dryRun) {
      await prisma.brand.create({
        data: {
          tenantId: targetId,
          name: row.name,
          description: row.description,
        },
      });
    }
    byName.add(nameKey(row.name));
    created += 1;
  }
  return { created, skipped, source: source.length };
}

async function cloneProductUnits(sourceId: string, targetId: string) {
  const source = await prisma.productUnit.findMany({
    where: { tenantId: sourceId, deletedAt: null },
  });
  const existing = await prisma.productUnit.findMany({
    where: { tenantId: targetId, deletedAt: null },
    select: { name: true, shortName: true },
  });
  const byName = new Set(existing.map((r) => nameKey(r.name)));
  const byShort = new Set(existing.map((r) => nameKey(r.shortName)));

  let created = 0;
  let skipped = 0;
  for (const row of source) {
    if (byName.has(nameKey(row.name)) || byShort.has(nameKey(row.shortName))) {
      skipped += 1;
      continue;
    }
    if (!dryRun) {
      await prisma.productUnit.create({
        data: {
          tenantId: targetId,
          name: row.name,
          shortName: row.shortName,
          allowDecimal: row.allowDecimal,
        },
      });
    }
    byName.add(nameKey(row.name));
    byShort.add(nameKey(row.shortName));
    created += 1;
  }
  return { created, skipped, source: source.length };
}

async function cloneDesignations(sourceId: string, targetId: string) {
  const source = await prisma.designation.findMany({
    where: { tenantId: sourceId, deletedAt: null },
  });
  const existing = await prisma.designation.findMany({
    where: { tenantId: targetId, deletedAt: null },
    select: { name: true },
  });
  const byName = new Set(existing.map((r) => nameKey(r.name)));

  let created = 0;
  let skipped = 0;
  for (const row of source) {
    if (byName.has(nameKey(row.name))) {
      skipped += 1;
      continue;
    }
    if (!dryRun) {
      await prisma.designation.create({
        data: {
          tenantId: targetId,
          name: row.name,
          description: row.description,
        },
      });
    }
    byName.add(nameKey(row.name));
    created += 1;
  }
  return { created, skipped, source: source.length };
}

async function cloneInvoiceSchemes(
  sourceId: string,
  targetId: string,
  targetCode: string,
) {
  const source = await prisma.invoiceScheme.findMany({
    where: { tenantId: sourceId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  const existing = await prisma.invoiceScheme.findMany({
    where: { tenantId: targetId, deletedAt: null },
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;

  // Prefer a single usable Default scheme with the target entity prefix.
  const defaultExisting = existing.find(
    (r) => nameKey(r.name) === 'default',
  );
  if (defaultExisting) {
    if (!defaultExisting.prefix || defaultExisting.prefix === 'VA') {
      if (!dryRun) {
        await prisma.invoiceScheme.update({
          where: { id: defaultExisting.id },
          data: { prefix: targetCode, isDefault: true },
        });
      }
      updated += 1;
    } else {
      skipped += 1;
    }
  } else if (source.length > 0) {
    const template = source[0]!;
    if (!dryRun) {
      await prisma.invoiceScheme.create({
        data: {
          tenantId: targetId,
          name: template.name || 'Default',
          prefix: targetCode,
          startNumber: template.startNumber,
          invoiceCount: 0,
          totalDigits: template.totalDigits,
          isDefault: true,
        },
      });
    }
    created += 1;
  }

  return {
    created,
    updated,
    skipped,
    source: source.length,
  };
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: { code: { in: [...OPERATING] } },
    select: { id: true, code: true },
  });
  const byCode = new Map(tenants.map((t) => [t.code, t]));
  const source = byCode.get(SOURCE_CODE);
  if (!source) {
    throw new Error(`Source tenant ${SOURCE_CODE} not found`);
  }

  const targets = tenants.filter((t) => {
    if (t.code === SOURCE_CODE) return false;
    if (onlyCode) return t.code === onlyCode;
    return true;
  });

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Cloning master data from ${SOURCE_CODE} → ${targets.map((t) => t.code).join(', ') || '(none)'}`,
  );

  for (const target of targets) {
    const accounts = await clonePaymentAccounts(source.id, target.id);
    const expenses = await cloneExpenseCategories(source.id, target.id);
    const categories = await cloneProductCategories(source.id, target.id);
    const brands = await cloneBrands(source.id, target.id);
    const units = await cloneProductUnits(source.id, target.id);
    const designations = await cloneDesignations(source.id, target.id);
    const schemes = await cloneInvoiceSchemes(
      source.id,
      target.id,
      target.code,
    );
    console.log(
      JSON.stringify({
        tenant: target.code,
        paymentAccounts: accounts,
        expenseCategories: expenses,
        productCategories: categories,
        brands,
        productUnits: units,
        designations,
        invoiceSchemes: schemes,
      }),
    );
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
