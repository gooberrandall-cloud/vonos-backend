/**
 * Backfill missing employee bank details from a mapping file (usually
 * extracted from the legacy Ultimate POS dumps — users.bank_details JSON).
 *
 * Fill-only: never overwrites an employee row that already has a value.
 * A mapping entry matches when:
 *   - name matches (case-insensitive, tenant matches if given), and
 *   - matchEmail (if given) matches the linked user's email local-part.
 *
 * Usage:
 *   npx tsx prisma/scripts/backfill-employee-banks-from-mapping.ts            # dry run
 *   npx tsx prisma/scripts/backfill-employee-banks-from-mapping.ts --apply    # write
 *   npx tsx prisma/scripts/backfill-employee-banks-from-mapping.ts --map path.json
 *   npx tsx prisma/scripts/backfill-employee-banks-from-mapping.ts --tenant VA --apply
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const tenantFlag = process.argv.indexOf('--tenant');
const TENANT_FILTER =
  tenantFlag !== -1 ? process.argv[tenantFlag + 1]?.toUpperCase() : undefined;
const mapFlag = process.argv.indexOf('--map');
const MAP_PATH = resolve(
  mapFlag !== -1 && process.argv[mapFlag + 1]
    ? process.argv[mapFlag + 1]
    : 'prisma/scripts/data/legacy-bank-backfill.json',
);

const prisma = new PrismaClient();

type Mapping = {
  name: string;
  tenant?: string;
  matchEmail?: string;
  accountHolderName?: string;
  bankAccountNo?: string;
  bankName?: string;
  bankBranch?: string;
  bankCode?: string;
  taxPayerId?: string;
};

const BANK_FIELDS = [
  'accountHolderName',
  'bankName',
  'bankBranch',
  'bankCode',
  'bankAccountNo',
  'taxPayerId',
] as const;

const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/, '')
    .replace(/[^a-z]/g, '');

async function main() {
  const mapping = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as Mapping[];
  const employees = await prisma.employee.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      tenantId: true,
      tenant: { select: { code: true } },
      user: { select: { email: true } },
      accountHolderName: true,
      bankName: true,
      bankBranch: true,
      bankCode: true,
      bankAccountNo: true,
      taxPayerId: true,
    },
  });

  let filled = 0;
  let unmatched = 0;

  for (const entry of mapping) {
    const entryTenant = TENANT_FILTER ?? entry.tenant;
    const targets = employees.filter((e) => {
      if (normName(e.name) !== normName(entry.name)) return false;
      if (entryTenant && e.tenant.code !== entryTenant) return false;
      if (entry.matchEmail && e.user?.email) {
        // Email guard: only when the row has a linked login. Legacy roster
        // rows without a user (e.g. OMEIZA) match on name (+ tenant).
        const want = entry.matchEmail.toLowerCase().split('@')[0];
        const have = e.user.email.toLowerCase().split('@')[0];
        if (have !== want) return false;
      }
      return true;
    });

    if (targets.length === 0) {
      unmatched++;
      console.log(`! no employee matched "${entry.name}"${entryTenant ? ` [${entryTenant}]` : ''}`);
      continue;
    }

    for (const target of targets) {
      const patch: Record<string, string> = {};
      for (const field of BANK_FIELDS) {
        const next = entry[field]?.trim();
        const current = target[field]?.trim();
        if (next && !current) patch[field] = next;
      }
      if (Object.keys(patch).length === 0) continue;
      filled++;
      console.log(
        `${APPLY ? '✓' : '~'} [${target.tenant.code}] ${target.name} (${target.id}) fills ${Object.keys(patch).join(', ')}` +
          ` → ${entry.bankAccountNo ?? ''} ${entry.bankName ?? ''}`.trimEnd(),
      );
      if (APPLY) {
        await prisma.employee.update({ where: { id: target.id }, data: patch });
      }
    }
  }

  console.log(
    `\n${filled} row(s) ${APPLY ? 'updated' : 'to update'}, ${unmatched} mapping entr(ies) unmatched.`,
  );
  if (!APPLY && filled > 0) console.log('Dry run — pass --apply to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
