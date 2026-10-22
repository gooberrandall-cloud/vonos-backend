/**
 * Fill missing bank details on a user's other employee rows.
 *
 * Two gaps made entered account numbers "disappear":
 *  1. Multi-entity staff have one employee row per tenant — the account number
 *     entered in one entity's profile never reached the other entity's row,
 *     whose payroll then showed a blank account number.
 *  2. Duplicate rows within a tenant (user invite re-ran createEmployee while
 *     a roster-sync row already existed) split payrolls across copies.
 *
 * This copies non-empty bank fields from the populated row onto blank
 * sibling rows of the same user (any tenant) — fill-only: never overwrites.
 *
 * Usage:
 *   npx tsx prisma/scripts/fill-duplicate-employee-bank-fields.ts          # dry run
 *   npx tsx prisma/scripts/fill-duplicate-employee-bank-fields.ts --apply  # write
 */
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

const BANK_FIELDS = [
  'accountHolderName',
  'bankName',
  'bankBranch',
  'bankCode',
  'bankAccountNo',
  'taxPayerId',
] as const;

type EmployeeRow = Record<(typeof BANK_FIELDS)[number], string | null> & {
  id: string;
  name: string;
  updatedAt: Date;
};

async function main() {
  const employees = (await prisma.employee.findMany({
    where: { deletedAt: null, userId: { not: null } },
    // grouped by userId across tenants (multi-entity staff), not per tenant,
    select: {
      id: true,
      name: true,
      tenantId: true,
      userId: true,
      updatedAt: true,
      accountHolderName: true,
      bankName: true,
      bankBranch: true,
      bankCode: true,
      bankAccountNo: true,
      taxPayerId: true,
      tenant: { select: { code: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })) as (EmployeeRow & {
    tenantId: string;
    userId: string;
    tenant: { code: string } | null;
  })[];

  const byUser = new Map<string, typeof employees>();
  for (const e of employees) {
    byUser.set(e.userId, [...(byUser.get(e.userId) ?? []), e]);
  }

  let groups = 0;
  let patched = 0;
  let sourceless = 0;

  for (const rows of byUser.values()) {
    if (rows.length < 2) continue;
    // group: every active row for this user, across tenants

    const source = rows.find((r) => r.bankAccountNo?.trim());
    if (!source) {
      sourceless++;
      if (rows.length > 1) {
        console.log(
          `! ${rows[0].tenant?.code} ${rows[0].name} — ${rows.length} rows, none has an account number (needs manual entry)`,
        );
      }
      continue;
    }
    groups++;

    for (const row of rows) {
      if (row.id === source.id) continue;
      const patch: Record<string, string> = {};
      for (const field of BANK_FIELDS) {
        const current = row[field]?.trim();
        const next = source[field]?.trim();
        if (!current && next) patch[field] = source[field]!.trim();
      }
      if (Object.keys(patch).length === 0) continue;

      console.log(
        `${APPLY ? '✓' : '~'} ${row.tenant?.code} ${row.name} (${row.id}) ← fills ${Object.keys(patch).join(', ')}` +
          ` from ${source.id}`,
      );
      patched++;
      if (APPLY) {
        await prisma.employee.update({ where: { id: row.id }, data: patch });
      }
    }
  }

  console.log(
    `\n${groups} duplicate-user group(s) with a bank source, ${patched} row(s) ${APPLY ? 'updated' : 'to update'}, ${sourceless} group(s) without any account on file.`,
  );
  if (!APPLY && patched > 0) console.log('Dry run — pass --apply to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
