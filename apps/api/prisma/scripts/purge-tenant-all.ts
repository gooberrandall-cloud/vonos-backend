/**
 * Soft-delete ALL operational + master data for selected tenants (default: VS, VKW).
 * Leaves tenant shell, roles, and users intact.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/purge-tenant-all.ts
 *   npx ts-node --transpile-only prisma/scripts/purge-tenant-all.ts --execute
 *   TENANT_CODES=VS,VKW npx ts-node --transpile-only prisma/scripts/purge-tenant-all.ts --execute
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');

const DEFAULT_CODES = ['VS', 'VKW'] as const;
const codes = (process.env.TENANT_CODES ?? DEFAULT_CODES.join(','))
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

const BATCH = 150;

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        /closed the connection|Can't reach database|P1017|P1001|timed out/i.test(
          msg,
        );
      console.warn(`  retry ${i}/${attempts} ${label}: ${msg.slice(0, 120)}`);
      if (!retryable || i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 800 * i));
      try {
        await prisma.$connect();
      } catch {
        /* ignore */
      }
    }
  }
  throw last;
}

async function chunkedIds(
  fetchPage: (cursor: string | undefined) => Promise<Array<{ id: string }>>,
): Promise<string[]> {
  const all: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    if (page.length === 0) break;
    for (const row of page) all.push(row.id);
    if (page.length < BATCH) break;
    cursor = page[page.length - 1]!.id;
  }
  return all;
}

async function softDeleteAll(
  tenantId: string,
  now: Date,
  label: string,
  countFn: () => Promise<number>,
  deleteFn: () => Promise<{ count: number }>,
): Promise<number> {
  const before = await countFn();
  if (before === 0 || dryRun) return before;
  await withRetry(label, deleteFn);
  return before;
}

async function purgeSales(tenantId: string, now: Date): Promise<number> {
  const saleWhere = { tenantId, deletedAt: null as null };
  const total = await prisma.sale.count({ where: saleWhere });
  if (total === 0 || dryRun) return total;

  const saleIds = await chunkedIds((cursor) =>
    prisma.sale.findMany({
      where: saleWhere,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  );

  for (let i = 0; i < saleIds.length; i += BATCH) {
    const batch = saleIds.slice(i, i + BATCH);
    await withRetry(`sale payments ${batch.length}`, () =>
      prisma.payment.updateMany({
        where: { tenantId, deletedAt: null, saleId: { in: batch } },
        data: { deletedAt: now },
      }),
    );
    await withRetry(`sale acctTxn ${batch.length}`, () =>
      prisma.accountTransaction.updateMany({
        where: { tenantId, deletedAt: null, saleId: { in: batch } },
        data: { deletedAt: now },
      }),
    );
    await withRetry(`sale ledger ${batch.length}`, () =>
      prisma.ledgerEntry.updateMany({
        where: {
          tenantId,
          deletedAt: null,
          linkedRecordType: 'sale',
          linkedRecordId: { in: batch },
        },
        data: { deletedAt: now },
      }),
    );
    await withRetry(`sale invoice ${batch.length}`, () =>
      prisma.$executeRaw`
        UPDATE "Invoice"
        SET "deletedAt" = ${now}, "jobId" = NULL,
            "reference" = "reference" || '__cleared_' || RIGHT(id, 8)
        WHERE "saleId" IN (${Prisma.join(batch)}) AND "deletedAt" IS NULL
      `,
    );
    await withRetry(`sale soft-delete ${batch.length}`, () =>
      prisma.$executeRaw`
        UPDATE "Sale"
        SET "deletedAt" = ${now}, "jobId" = NULL,
            "reference" = "reference" || '__cleared_' || RIGHT(id, 8)
        WHERE id IN (${Prisma.join(batch)}) AND "deletedAt" IS NULL
      `,
    );
  }
  return total;
}

async function purgeExpenses(tenantId: string, now: Date): Promise<number> {
  const expenseWhere = { tenantId, deletedAt: null as null };
  const total = await prisma.expense.count({ where: expenseWhere });
  if (total === 0 || dryRun) return total;

  const expenseIds = await chunkedIds((cursor) =>
    prisma.expense.findMany({
      where: expenseWhere,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  );

  for (let i = 0; i < expenseIds.length; i += BATCH) {
    const batch = expenseIds.slice(i, i + BATCH);
    await withRetry(`expense acctTxn ${batch.length}`, () =>
      prisma.accountTransaction.updateMany({
        where: { tenantId, deletedAt: null, expenseId: { in: batch } },
        data: { deletedAt: now },
      }),
    );
    await withRetry(`expense ledger ${batch.length}`, () =>
      prisma.ledgerEntry.updateMany({
        where: {
          tenantId,
          deletedAt: null,
          linkedRecordType: 'expense',
          linkedRecordId: { in: batch },
        },
        data: { deletedAt: now },
      }),
    );
    await withRetry(`expense invoice ${batch.length}`, () =>
      prisma.$executeRaw`
        UPDATE "Invoice"
        SET "deletedAt" = ${now},
            "reference" = "reference" || '__cleared_' || RIGHT(id, 8)
        WHERE "expenseId" IN (${Prisma.join(batch)}) AND "deletedAt" IS NULL
      `,
    );
    await withRetry(`expense soft-delete ${batch.length}`, () =>
      prisma.expense.updateMany({
        where: { id: { in: batch }, deletedAt: null },
        data: { deletedAt: now },
      }),
    );
  }
  return total;
}

async function purgeJobs(tenantId: string, now: Date): Promise<number> {
  const jobWhere = { tenantId, deletedAt: null as null };
  const total = await prisma.job.count({ where: jobWhere });
  if (total === 0 || dryRun) return total;

  const jobIds = await chunkedIds((cursor) =>
    prisma.job.findMany({
      where: jobWhere,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  );

  for (let i = 0; i < jobIds.length; i += BATCH) {
    const batch = jobIds.slice(i, i + BATCH);
    await withRetry(`job materials ${batch.length}`, () =>
      prisma.jobMaterial.deleteMany({ where: { jobId: { in: batch } } }),
    );
    await withRetry(`job labour ${batch.length}`, () =>
      prisma.jobLabour.deleteMany({ where: { jobId: { in: batch } } }),
    );
    await withRetry(`job invoices ${batch.length}`, () =>
      prisma.$executeRaw`
        UPDATE "Invoice"
        SET "deletedAt" = ${now}, "jobId" = NULL,
            "reference" = "reference" || '__cleared_' || RIGHT(id, 8)
        WHERE "jobId" IN (${Prisma.join(batch)}) AND "deletedAt" IS NULL
      `,
    );
    await withRetry(`job soft-delete ${batch.length}`, () =>
      prisma.job.updateMany({
        where: { id: { in: batch }, deletedAt: null },
        data: { deletedAt: now },
      }),
    );
  }
  return total;
}

async function purgeItems(tenantId: string, now: Date): Promise<number> {
  const itemWhere = { tenantId, deletedAt: null as null };
  const total = await prisma.item.count({ where: itemWhere });
  if (total === 0 || dryRun) return total;

  await withRetry('itemLocationStock', () =>
    prisma.itemLocationStock.deleteMany({ where: { tenantId } }),
  );

  const itemIds = await chunkedIds((cursor) =>
    prisma.item.findMany({
      where: itemWhere,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  );

  for (let i = 0; i < itemIds.length; i += BATCH) {
    const batch = itemIds.slice(i, i + BATCH);
    await withRetry(`item soft-delete ${batch.length}`, () =>
      prisma.item.updateMany({
        where: { id: { in: batch }, deletedAt: null },
        data: { deletedAt: now, quantity: 0 },
      }),
    );
  }
  return total;
}

type Counts = Record<string, number>;

async function purgeTenant(tenantId: string, code: string): Promise<Counts> {
  const now = new Date();
  const counts: Counts = {};

  counts.payment = await softDeleteAll(
    tenantId,
    now,
    'payments',
    () => prisma.payment.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.payment.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );

  counts.accountTransaction = await softDeleteAll(
    tenantId,
    now,
    'accountTransaction',
    () =>
      prisma.accountTransaction.count({
        where: { tenantId, deletedAt: null },
      }),
    () =>
      prisma.accountTransaction.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );

  counts.ledgerEntry = await softDeleteAll(
    tenantId,
    now,
    'ledgerEntry',
    () => prisma.ledgerEntry.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.ledgerEntry.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );

  counts.invoice = await softDeleteAll(
    tenantId,
    now,
    'invoice',
    () => prisma.invoice.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.invoice.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );

  counts.sale = await purgeSales(tenantId, now);
  counts.expense = await purgeExpenses(tenantId, now);

  counts.stockMovement = await softDeleteAll(
    tenantId,
    now,
    'stockMovement',
    () => prisma.stockMovement.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.stockMovement.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );

  counts.job = await purgeJobs(tenantId, now);
  counts.appointment = await softDeleteAll(
    tenantId,
    now,
    'appointment',
    () => prisma.appointment.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.appointment.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );
  counts.requisition = await softDeleteAll(
    tenantId,
    now,
    'requisition',
    () => prisma.requisition.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.requisition.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );
  counts.vehicle = await softDeleteAll(
    tenantId,
    now,
    'vehicle',
    () => prisma.vehicle.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.vehicle.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );
  counts.salonService = await softDeleteAll(
    tenantId,
    now,
    'salonService',
    () => prisma.salonService.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.salonService.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );
  counts.cafeTable = await softDeleteAll(
    tenantId,
    now,
    'cafeTable',
    () => prisma.cafeTable.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.cafeTable.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );

  counts.item = await purgeItems(tenantId, now);

  counts.payroll = await softDeleteAll(
    tenantId,
    now,
    'payroll',
    () => prisma.payroll.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.payroll.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );
  counts.employee = await softDeleteAll(
    tenantId,
    now,
    'employee',
    () => prisma.employee.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.employee.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );
  counts.leave = await softDeleteAll(
    tenantId,
    now,
    'leave',
    () => prisma.leave.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.leave.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );
  counts.attendance = await softDeleteAll(
    tenantId,
    now,
    'attendance',
    () => prisma.attendance.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.attendance.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );

  counts.customer = await softDeleteAll(
    tenantId,
    now,
    'customer',
    () => prisma.customer.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.customer.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );
  counts.supplier = await softDeleteAll(
    tenantId,
    now,
    'supplier',
    () => prisma.supplier.count({ where: { tenantId, deletedAt: null } }),
    () =>
      prisma.supplier.updateMany({
        where: { tenantId, deletedAt: null },
        data: { deletedAt: now },
      }),
  );

  const masterModels = [
    ['productCategory', prisma.productCategory],
    ['brand', prisma.brand],
    ['productUnit', prisma.productUnit],
    ['warranty', prisma.warranty],
    ['sellingPriceGroup', prisma.sellingPriceGroup],
    ['discount', prisma.discount],
    ['variationTemplate', prisma.variationTemplate],
    ['customerGroup', prisma.customerGroup],
    ['expenseCategory', prisma.expenseCategory],
    ['payrollGroup', prisma.payrollGroup],
    ['designation', prisma.designation],
    ['leaveType', prisma.leaveType],
    ['holiday', prisma.holiday],
    ['attendanceShift', prisma.attendanceShift],
    ['salesTarget', prisma.salesTarget],
    ['payComponent', prisma.payComponent],
    ['paymentAccount', prisma.paymentAccount],
    ['invoiceLayout', prisma.invoiceLayout],
    ['invoiceScheme', prisma.invoiceScheme],
    ['receiptPrinter', prisma.receiptPrinter],
  ] as const;

  for (const [key, model] of masterModels) {
    counts[key] = await softDeleteAll(
      tenantId,
      now,
      key,
      () => model.count({ where: { tenantId, deletedAt: null } }),
      () =>
        model.updateMany({
          where: { tenantId, deletedAt: null },
          data: { deletedAt: now },
        }),
    );
  }

  const notifCount = await prisma.notification.count({ where: { tenantId } });
  counts.notification = notifCount;
  if (!dryRun && notifCount > 0) {
    await withRetry('notification', () =>
      prisma.notification.deleteMany({ where: { tenantId } }),
    );
  }

  const legacyCount = await prisma.migrationLegacyId.count({
    where: { tenantId },
  });
  counts.migrationLegacyId = legacyCount;
  if (!dryRun && legacyCount > 0) {
    await withRetry('migrationLegacyId', () =>
      prisma.migrationLegacyId.deleteMany({ where: { tenantId } }),
    );
  }

  if (!dryRun) {
    await withRetry('tenantEntitySnapshot reset', () =>
      prisma.tenantEntitySnapshot.update({
        where: { tenantId },
        data: {
          sku: 0,
          stockValue: 0,
          lowStock: 0,
          inboundToday: 0,
          salesTodayRevenue: 0,
          salesReturns: 0,
          activeJobs: 0,
          pendingQc: 0,
          jobRevenueToday: 0,
          apptsToday: 0,
          apptRevenueToday: 0,
          retailLowStock: 0,
          pendingInbound: 0,
        },
      }).catch(() => ({ tenantId })),
    );
    await withRetry('tenantDailyFinance', () =>
      prisma.tenantDailyFinance.deleteMany({ where: { tenantId } }),
    );
  }

  return counts;
}

async function main() {
  if (codes.length === 0) {
    console.error('No TENANT_CODES provided');
    process.exit(1);
  }

  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, code: { in: codes } },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });

  if (tenants.length === 0) {
    console.error(`No tenants found for: ${codes.join(', ')}`);
    process.exit(1);
  }

  console.log(
    dryRun
      ? 'DRY-RUN — pass --execute to purge all tenant data'
      : 'EXECUTE — purging all data for selected tenants',
  );
  console.log(`Tenants: ${tenants.map((t) => t.code).join(', ')}`);
  console.log('(Keeps tenant record, roles, and users)\n');

  let grandTotal = 0;

  for (const tenant of tenants) {
    console.log(`[${tenant.code}] ${tenant.name}`);
    const counts = await purgeTenant(tenant.id, tenant.code);
    const lines = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [key, n] of lines) {
      console.log(`  ${key}: ${n}`);
      grandTotal += n;
    }
    const tenantTotal = lines.reduce((s, [, n]) => s + n, 0);
    console.log(`  --- subtotal: ${tenantTotal}\n`);
  }

  console.log(
    dryRun
      ? `Dry-run complete. Would purge ${grandTotal} records total.`
      : `Execute complete. Purged ${grandTotal} records total.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
