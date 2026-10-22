/**
 * One-off: attach real-money payrolls with employeeRecordId = null to their
 * employee row (same tenant, exact normalized name match).
 *
 * - Fill-only: never re-links a payroll that already has an employeeRecordId.
 * - Matching normalizes case/whitespace and strips titles (Mr/Mrs/Miss/...),
 *   so payroll "Sanusi Haruna" finds employee "Mr Sanusi Haruna".
 * - When several employee rows share a name (import duplicates), the unique
 *   row with a linked user account wins — that row is the active profile.
 *   Still-tied names are reported and skipped.
 * - Default is a dry run; pass --apply to write.
 *
 *   npx tsx prisma/scripts/link-orphan-payrolls-to-employees.ts
 *   npx tsx prisma/scripts/link-orphan-payrolls-to-employees.ts --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const norm = (s: string | null) =>
  (s ?? '')
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|dr|prof)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

type Orphan = {
  id: string;
  employeeName: string;
  netPay: unknown;
  paymentStatus: string;
  tenantId: string | null;
  tenantCode: string | null;
};

type Employee = { id: string; name: string; tenantId: string; userId: string | null };

function resolve(orphan: Orphan, pool: Employee[]): { employee: Employee; via: string } | null | 'ambiguous' {
  const matches = pool.filter((e) => e.tenantId === orphan.tenantId && norm(e.name) === norm(orphan.employeeName));
  if (matches.length === 1) return { employee: matches[0], via: 'exact' };
  if (matches.length === 0) return null;
  const withUser = matches.filter((e) => e.userId);
  if (withUser.length === 1) return { employee: withUser[0], via: 'duplicate→user-linked row' };
  return 'ambiguous';
}

async function main() {
  const orphans = await prisma.payroll.findMany({
    where: { deletedAt: null, employeeRecordId: null, netPay: { gt: 0 } },
    select: {
      id: true, employeeName: true, netPay: true, paymentStatus: true,
      tenant: { select: { id: true, code: true } },
    },
  });
  const employees = await prisma.employee.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, tenantId: true, userId: true },
  });

  const pool: Employee[] = employees;
  const plan: { orphanId: string; employeeId: string }[] = [];
  let linkable = 0, ambiguous = 0, unmatched = 0;

  for (const raw of orphans) {
    const o: Orphan = {
      id: raw.id, employeeName: raw.employeeName, netPay: raw.netPay,
      paymentStatus: raw.paymentStatus,
      tenantId: raw.tenant?.id ?? null, tenantCode: raw.tenant?.code ?? null,
    };
    const res = resolve(o, pool);
    if (res === null) {
      unmatched++;
      console.log(`! [${o.tenantCode}] ${o.employeeName} — no employee row with that name`);
    } else if (res === 'ambiguous') {
      ambiguous++;
      console.log(`? [${o.tenantCode}] ${o.employeeName} — duplicate rows, no user-linked tiebreak, skipped`);
    } else {
      linkable++;
      plan.push({ orphanId: o.id, employeeId: res.employee.id });
      console.log(
        `~ [${o.tenantCode}] ${o.employeeName} net=${o.netPay} (${o.paymentStatus}) → ${res.employee.id} (${res.via})`
      );
    }
  }

  console.log(
    `\norphan real-money payrolls: ${orphans.length} — linkable: ${linkable}, ambiguous: ${ambiguous}, unmatched: ${unmatched}`
  );

  if (APPLY && plan.length) {
    let done = 0;
    for (const p of plan) {
      const res = await prisma.payroll.updateMany({
        where: { id: p.orphanId, employeeRecordId: null },
        data: { employeeRecordId: p.employeeId },
      });
      done += res.count;
    }
    console.log(`✓ linked ${done} payrolls`);
  } else if (APPLY) {
    console.log('nothing to link');
  } else {
    console.log('Dry run — pass --apply to write.');
  }
}

main().finally(() => prisma.$disconnect());
