/**
 * Rename legacy job stage labels to the current pipeline.
 *
 *   Quoted             → Diagnosis and billing
 *   In Progress        → In progress
 *   QC                 → Quality check
 *   Delivered          → Vehicle collected
 *
 * Covers both places a stage is persisted: `Job.status` and the `Job status:`
 * line in `Sale.notes` (VA/VP sales act as jobs). The historical
 * `Job status log:` / `qcNotes` entries are left untouched — readers coerce
 * legacy labels, so old audit trails keep rendering.
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/backfill-job-stage-labels.ts
 *   npx ts-node ... backfill-job-stage-labels.ts --tenant=VA
 *   npx ts-node ... backfill-job-stage-labels.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const tenantCode = tenantArg?.split('=')[1]?.toUpperCase();

const STAGE_RENAMES: Record<string, string> = {
  Quoted: 'Diagnosis and billing',
  'In Progress': 'In progress',
  QC: 'Quality check',
  Delivered: 'Vehicle collected',
};

const JOB_STATUS_LINE = /^Job status:\s*(.+)$/im;

async function resolveTenantId(): Promise<string | undefined> {
  if (!tenantCode) return undefined;
  const tenant = await prisma.tenant.findFirst({
    where: { code: tenantCode, deletedAt: null },
    select: { id: true },
  });
  if (!tenant) throw new Error(`Tenant not found: ${tenantCode}`);
  return tenant.id;
}

async function backfillJobs(tenantId?: string): Promise<number> {
  const where = tenantId ? { tenantId } : {};
  let total = 0;

  for (const [from, to] of Object.entries(STAGE_RENAMES)) {
    const count = await prisma.job.count({ where: { ...where, status: from } });
    if (count === 0) continue;

    if (dryRun) {
      console.log(`[dry-run] Job.status  ${from} → ${to}: ${count} rows`);
    } else {
      const result = await prisma.job.updateMany({
        where: { ...where, status: from },
        data: { status: to },
      });
      console.log(`Job.status  ${from} → ${to}: ${result.count} rows`);
    }
    total += count;
  }

  return total;
}

function rewriteSaleNotes(
  notes: string,
): { notes: string; from: string; to: string } | null {
  if (!notes.includes('Job status:')) return null;
  const lines = notes.split('\n');
  let changed = false;
  let from = '';
  let to = '';

  const next = lines.map((line) => {
    const match = line.match(JOB_STATUS_LINE);
    if (!match) return line;
    const current = match[1]?.trim() ?? '';
    const mapped = STAGE_RENAMES[current];
    if (!mapped) return line;
    changed = true;
    from = current;
    to = mapped;
    return `Job status: ${mapped}`;
  });

  return changed ? { notes: next.join('\n'), from, to } : null;
}

async function backfillSaleNotes(tenantId?: string): Promise<number> {
  const rows = await prisma.sale.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      deletedAt: null,
      notes: { contains: 'Job status:' },
    },
    select: { id: true, notes: true },
  });

  let updated = 0;
  for (const row of rows) {
    if (!row.notes) continue;
    const next = rewriteSaleNotes(row.notes);
    if (!next) continue;
    if (dryRun) {
      console.log(`[dry-run] Sale.notes  ${next.from} → ${next.to}: ${row.id}`);
    } else {
      await prisma.sale.update({
        where: { id: row.id },
        data: { notes: next.notes },
      });
    }
    updated += 1;
  }

  return updated;
}

async function main(): Promise<void> {
  const tenantId = await resolveTenantId();
  console.log(
    `${dryRun ? '[dry-run] ' : ''}Renaming legacy job stage labels${
      tenantCode ? ` for tenant ${tenantCode}` : ' (all tenants)'
    }…`,
  );

  const jobs = await backfillJobs(tenantId);
  const sales = await backfillSaleNotes(tenantId);

  console.log(
    `\n${dryRun ? 'Would update' : 'Updated'} ${jobs} Job rows and ${sales} Sale.notes rows.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
