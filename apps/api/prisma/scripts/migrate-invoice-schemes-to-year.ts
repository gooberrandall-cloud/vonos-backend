/**
 * Migrate invoice schemes to year/number format (e.g. 2026/0001).
 * - Sets prefix to `{year}/` when blank or tenant-code style (VA, VP, …)
 * - Keeps invoiceCount / startNumber (sequence continues)
 * - Leaves a single isDefault scheme per tenant (highest invoiceCount wins)
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/migrate-invoice-schemes-to-year.ts
 *   npx ts-node --transpile-only prisma/scripts/migrate-invoice-schemes-to-year.ts --execute
 */
import { PrismaClient } from '@prisma/client';
import {
  defaultYearInvoicePrefix,
  isTenantCodeInvoicePrefix,
  isYearInvoicePrefix,
} from '../../src/common/utils/allocateInvoiceNumber';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');

async function main() {
  const yearPrefix = defaultYearInvoicePrefix();
  const schemes = await prisma.invoiceScheme.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      tenantId: true,
      name: true,
      prefix: true,
      startNumber: true,
      invoiceCount: true,
      totalDigits: true,
      isDefault: true,
      tenant: { select: { code: true } },
    },
    orderBy: [{ tenantId: 'asc' }, { invoiceCount: 'desc' }],
  });

  console.log(
    dryRun
      ? 'DRY RUN — pass --execute to apply'
      : 'EXECUTE — writing year/number invoice schemes',
  );
  console.log(`Target prefix: ${yearPrefix}`);

  const byTenant = new Map<string, typeof schemes>();
  for (const row of schemes) {
    const list = byTenant.get(row.tenantId) ?? [];
    list.push(row);
    byTenant.set(row.tenantId, list);
  }

  let updated = 0;
  let demoted = 0;

  for (const [tenantId, rows] of byTenant) {
    const code = rows[0]?.tenant.code ?? tenantId;
    const ranked = [...rows].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return b.invoiceCount - a.invoiceCount;
    });
    const keep = ranked[0];
    if (!keep) continue;

    for (const row of ranked) {
      const needsPrefix =
        !row.prefix?.trim() ||
        isTenantCodeInvoicePrefix(row.prefix) ||
        (isYearInvoicePrefix(row.prefix) && row.prefix.trim() !== yearPrefix);
      const shouldBeDefault = row.id === keep.id;
      const needsDefault = row.isDefault !== shouldBeDefault;
      const needsDigits = row.totalDigits < 4;

      if (!needsPrefix && !needsDefault && !needsDigits) {
        console.log(
          `  ${code} keep ${row.name} prefix=${JSON.stringify(row.prefix)} count=${row.invoiceCount} default=${row.isDefault}`,
        );
        continue;
      }

      const nextPrefix = needsPrefix ? yearPrefix : row.prefix;
      const nextDigits = needsDigits ? 4 : row.totalDigits;
      console.log(
        `  ${code} ${row.id.slice(-6)} ${row.name}: prefix ${JSON.stringify(row.prefix)} → ${JSON.stringify(nextPrefix)}, default ${row.isDefault} → ${shouldBeDefault}, digits ${row.totalDigits} → ${nextDigits}`,
      );

      if (!dryRun) {
        await prisma.invoiceScheme.update({
          where: { id: row.id },
          data: {
            prefix: nextPrefix,
            totalDigits: nextDigits,
            isDefault: shouldBeDefault,
          },
        });
      }
      if (needsPrefix || needsDigits) updated += 1;
      if (needsDefault && !shouldBeDefault) demoted += 1;
    }
  }

  console.log(
    `\n${dryRun ? 'Would update' : 'Updated'} ${updated} scheme(s); demoted ${demoted} extra default(s).`,
  );

  if (!dryRun) {
    // Preview next allocate for each operating tenant default.
    const defaults = await prisma.invoiceScheme.findMany({
      where: { deletedAt: null, isDefault: true },
      select: {
        prefix: true,
        startNumber: true,
        invoiceCount: true,
        totalDigits: true,
        tenant: { select: { code: true } },
      },
      orderBy: { tenant: { code: 'asc' } },
    });
    const { formatInvoiceNumber } = await import(
      '../../src/common/utils/allocateInvoiceNumber'
    );
    console.log('\nNext invoice numbers (after allocate +1):');
    for (const d of defaults) {
      const next = d.startNumber + d.invoiceCount;
      console.log(
        `  ${d.tenant.code}\t${formatInvoiceNumber(d.prefix, next, d.totalDigits)}`,
      );
    }
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
