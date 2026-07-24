/**
 * Backfill Invoice headers for existing domain records and relink payments/ledger.
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/backfill-invoices.ts
 *   npx ts-node ... backfill-invoices.ts --tenant=VA
 *   npx ts-node ... backfill-invoices.ts --dry-run
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const tenantCode = tenantArg?.split('=')[1]?.toUpperCase();
const BATCH = 250;

function toNum(v: { toString(): string } | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

async function resolveTenantId(): Promise<string | undefined> {
  if (!tenantCode) return undefined;
  const tenant = await prisma.tenant.findFirst({
    where: { code: tenantCode, deletedAt: null },
    select: { id: true },
  });
  if (!tenant) throw new Error(`Tenant not found: ${tenantCode}`);
  return tenant.id;
}

async function loadLegacyMap(
  tenantId?: string,
): Promise<Map<string, number>> {
  const rows = await prisma.migrationLegacyId.findMany({
    where: tenantId ? { tenantId } : {},
    select: { tenantId: true, entityType: true, newId: true, legacyId: true },
  });
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(`${row.tenantId}:${row.entityType}:${row.newId}`, row.legacyId);
  }
  return map;
}

function legacyFromMap(
  map: Map<string, number>,
  tenantId: string,
  entityType: string,
  newId: string,
): number | null {
  return map.get(`${tenantId}:${entityType}:${newId}`) ?? null;
}

async function createManyBatched(
  label: string,
  rows: Prisma.InvoiceCreateManyInput[],
): Promise<number> {
  if (rows.length === 0) return 0;
  if (dryRun) {
    console.log(`  [dry-run] ${label}: would create ${rows.length}`);
    return rows.length;
  }
  let created = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const result = await prisma.invoice.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    created += result.count;
    console.log(
      `  ${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length} (inserted ${created})`,
    );
  }
  return created;
}

async function main() {
  const tenantId = await resolveTenantId();
  const tenantFilter = tenantId ? { tenantId } : {};
  const legacyMap = await loadLegacyMap(tenantId);
  console.log(
    `Starting invoice backfill${tenantCode ? ` for ${tenantCode}` : ''}${dryRun ? ' (dry-run)' : ''}…`,
  );

  const existing = await prisma.invoice.findMany({
    where: { ...tenantFilter, deletedAt: null },
    select: {
      saleId: true,
      stockMovementId: true,
      expenseId: true,
      payrollId: true,
      payrollGroupId: true,
      jobId: true,
      kind: true,
    },
  });
  const saleDone = new Set(
    existing.map((e) => e.saleId).filter(Boolean) as string[],
  );
  const movDone = new Set(
    existing.map((e) => e.stockMovementId).filter(Boolean) as string[],
  );
  const expDone = new Set(
    existing.map((e) => e.expenseId).filter(Boolean) as string[],
  );
  const payDone = new Set(
    existing.map((e) => e.payrollId).filter(Boolean) as string[],
  );
  const groupDone = new Set(
    existing.map((e) => e.payrollGroupId).filter(Boolean) as string[],
  );
  const quoteDone = new Set(
    existing
      .filter((e) => e.kind === 'job_quote' && e.jobId)
      .map((e) => e.jobId as string),
  );
  const jobInvDone = new Set(
    existing
      .filter((e) => e.kind === 'job_invoice' && e.jobId)
      .map((e) => e.jobId as string),
  );
  console.log(`Existing invoices: ${existing.length}`);

  // --- Sales ---
  const sales = await prisma.sale.findMany({
    where: { ...tenantFilter, deletedAt: null },
    select: {
      id: true,
      tenantId: true,
      reference: true,
      status: true,
      paymentStatus: true,
      currency: true,
      total: true,
      taxAmount: true,
      discountAmount: true,
      date: true,
      notes: true,
      customerId: true,
      customer: { select: { name: true } },
      lines: { select: { lineTotal: true } },
    },
  });
  const saleRows: Prisma.InvoiceCreateManyInput[] = [];
  for (const sale of sales) {
    if (saleDone.has(sale.id)) continue;
    const subtotal = sale.lines.reduce((s, l) => s + toNum(l.lineTotal), 0);
    saleRows.push({
      tenantId: sale.tenantId,
      reference: sale.reference,
      kind: 'sale',
      status:
        sale.status === 'quotation' || sale.status === 'draft'
          ? sale.status
          : 'final',
      paymentStatus: sale.paymentStatus,
      currency: sale.currency,
      subtotal,
      taxAmount: sale.taxAmount != null ? toNum(sale.taxAmount) : null,
      discountAmount:
        sale.discountAmount != null ? toNum(sale.discountAmount) : null,
      total: toNum(sale.total),
      documentDate: sale.date,
      notes: sale.notes,
      customerId: sale.customerId,
      contactName: sale.customer?.name ?? null,
      saleId: sale.id,
      legacyId: legacyFromMap(legacyMap, sale.tenantId, 'sale', sale.id),
    });
  }
  const salesCreated = await createManyBatched('sales', saleRows);

  // --- Purchases (inbound movements) ---
  const movements = await prisma.stockMovement.findMany({
    where: { ...tenantFilter, deletedAt: null, type: 'inbound' },
    select: {
      id: true,
      tenantId: true,
      reference: true,
      status: true,
      paymentStatus: true,
      date: true,
      notes: true,
      supplierId: true,
      lines: true,
      supplier: { select: { name: true } },
    },
  });
  const purchaseRows: Prisma.InvoiceCreateManyInput[] = [];
  for (const mov of movements) {
    if (movDone.has(mov.id)) continue;
    const lines = Array.isArray(mov.lines)
      ? (mov.lines as Array<{ quantity?: number; unitCost?: number }>)
      : [];
    const total = lines.reduce(
      (s, l) => s + (l.quantity ?? 0) * (l.unitCost ?? 0),
      0,
    );
    purchaseRows.push({
      tenantId: mov.tenantId,
      reference: mov.reference,
      kind: 'purchase',
      status: mov.status.toLowerCase(),
      paymentStatus: mov.paymentStatus,
      total,
      subtotal: total,
      documentDate: mov.date,
      notes: mov.notes,
      supplierId: mov.supplierId,
      contactName: mov.supplier?.name ?? null,
      stockMovementId: mov.id,
      legacyId: legacyFromMap(
        legacyMap,
        mov.tenantId,
        'stock_movement',
        mov.id,
      ),
    });
  }
  const purchasesCreated = await createManyBatched('purchases', purchaseRows);

  // --- Expenses ---
  const expenses = await prisma.expense.findMany({
    where: { ...tenantFilter, deletedAt: null },
    select: {
      id: true,
      tenantId: true,
      refNo: true,
      totalAmount: true,
      taxAmount: true,
      paymentStatus: true,
      expenseDate: true,
      note: true,
      expenseForCustomerId: true,
      contactName: true,
    },
  });
  const expenseRows: Prisma.InvoiceCreateManyInput[] = [];
  for (const exp of expenses) {
    if (expDone.has(exp.id)) continue;
    expenseRows.push({
      tenantId: exp.tenantId,
      reference: exp.refNo?.trim() || `EXP-${exp.id.slice(-8).toUpperCase()}`,
      kind: 'expense',
      status: 'final',
      paymentStatus: exp.paymentStatus,
      total: toNum(exp.totalAmount),
      taxAmount: toNum(exp.taxAmount),
      subtotal: toNum(exp.totalAmount),
      documentDate: exp.expenseDate,
      notes: exp.note,
      customerId: exp.expenseForCustomerId,
      contactName: exp.contactName,
      expenseId: exp.id,
      legacyId: legacyFromMap(legacyMap, exp.tenantId, 'expense', exp.id),
    });
  }
  const expensesCreated = await createManyBatched('expenses', expenseRows);

  // --- Payroll slips ---
  const payrolls = await prisma.payroll.findMany({
    where: { ...tenantFilter, deletedAt: null },
    select: {
      id: true,
      tenantId: true,
      employeeName: true,
      employeeRecordId: true,
      netPay: true,
      grossPay: true,
      paymentStatus: true,
      status: true,
      payrollMonth: true,
      note: true,
    },
  });
  const payrollRows: Prisma.InvoiceCreateManyInput[] = [];
  for (const row of payrolls) {
    if (payDone.has(row.id)) continue;
    const month = row.payrollMonth.toISOString().slice(0, 7);
    const reference = `PAY-${month}-${row.employeeName.replace(/\s+/g, '-').slice(0, 24)}-${row.id.slice(-6)}`;
    payrollRows.push({
      tenantId: row.tenantId,
      reference,
      kind: 'payroll',
      status: row.status,
      paymentStatus: row.paymentStatus,
      total: toNum(row.netPay),
      subtotal: toNum(row.grossPay),
      documentDate: row.payrollMonth,
      notes: row.note,
      employeeRecordId: row.employeeRecordId,
      contactName: row.employeeName,
      payrollId: row.id,
      legacyId: legacyFromMap(legacyMap, row.tenantId, 'payroll', row.id),
    });
  }
  const payrollsCreated = await createManyBatched('payrolls', payrollRows);

  // --- Payroll groups ---
  const groups = await prisma.payrollGroup.findMany({
    where: { ...tenantFilter, deletedAt: null },
    select: {
      id: true,
      tenantId: true,
      name: true,
      createdAt: true,
      payrolls: {
        where: { deletedAt: null },
        select: { netPay: true },
      },
    },
  });
  const groupRows: Prisma.InvoiceCreateManyInput[] = [];
  for (const group of groups) {
    if (groupDone.has(group.id)) continue;
    const grossTotal = group.payrolls.reduce((s, p) => s + toNum(p.netPay), 0);
    // Suffix id so duplicate department names stay unique under (tenantId, reference, kind).
    groupRows.push({
      tenantId: group.tenantId,
      reference: `${group.name}-${group.id.slice(-6)}`,
      kind: 'payroll_group',
      status: 'final',
      paymentStatus: 'due',
      total: grossTotal,
      subtotal: grossTotal,
      documentDate: group.createdAt,
      contactName: group.name,
      payrollGroupId: group.id,
    });
  }
  const groupsCreated = await createManyBatched('payroll_groups', groupRows);

  // --- Jobs (quote / invoice) ---
  const jobs = await prisma.job.findMany({
    where: { ...tenantFilter, deletedAt: null },
    select: {
      id: true,
      tenantId: true,
      reference: true,
      customerId: true,
      customerName: true,
      hasQuote: true,
      quoteAmount: true,
      quoteNotes: true,
      quoteValidUntil: true,
      invoiceAmount: true,
      invoiceNotes: true,
      createdAt: true,
    },
  });
  const quoteRows: Prisma.InvoiceCreateManyInput[] = [];
  const jobInvRows: Prisma.InvoiceCreateManyInput[] = [];
  for (const job of jobs) {
    const legacyId = legacyFromMap(legacyMap, job.tenantId, 'job', job.id);
    if (!quoteDone.has(job.id) && (job.hasQuote || job.quoteAmount != null)) {
      const total = job.quoteAmount != null ? toNum(job.quoteAmount) : 0;
      quoteRows.push({
        tenantId: job.tenantId,
        reference: `${job.reference}-Q`,
        kind: 'job_quote',
        status: 'final',
        paymentStatus: 'due',
        total,
        subtotal: total,
        documentDate: job.createdAt,
        dueDate: job.quoteValidUntil,
        notes: job.quoteNotes,
        customerId: job.customerId,
        contactName: job.customerName,
        jobId: job.id,
        legacyId,
      });
    }
    if (!jobInvDone.has(job.id) && job.invoiceAmount != null) {
      const total = toNum(job.invoiceAmount);
      jobInvRows.push({
        tenantId: job.tenantId,
        reference: `${job.reference}-INV`,
        kind: 'job_invoice',
        status: 'final',
        paymentStatus: 'due',
        total,
        subtotal: total,
        documentDate: job.createdAt,
        notes: job.invoiceNotes,
        customerId: job.customerId,
        contactName: job.customerName,
        jobId: job.id,
        legacyId,
      });
    }
  }
  const quotesCreated = await createManyBatched('job_quotes', quoteRows);
  const jobInvsCreated = await createManyBatched('job_invoices', jobInvRows);

  // --- Bulk relink payments / ledger / account transactions ---
  let paymentsLinked = 0;
  let ledgerLinked = 0;
  if (!dryRun) {
    console.log('Relinking payments / ledger / account transactions…');
    const tenantClause = tenantId
      ? Prisma.sql`AND i."tenantId" = ${tenantId}`
      : Prisma.empty;

    const payResult = await prisma.$executeRaw`
      UPDATE "Payment" p
      SET "invoiceId" = i.id
      FROM "Invoice" i
      WHERE p."saleId" = i."saleId"
        AND p."invoiceId" IS NULL
        AND p."deletedAt" IS NULL
        AND i."deletedAt" IS NULL
        AND i."saleId" IS NOT NULL
        ${tenantClause}
    `;
    paymentsLinked = Number(payResult);

    const acctResult = await prisma.$executeRaw`
      UPDATE "AccountTransaction" a
      SET "invoiceId" = i.id
      FROM "Invoice" i
      WHERE a."saleId" = i."saleId"
        AND a."invoiceId" IS NULL
        AND a."deletedAt" IS NULL
        AND i."deletedAt" IS NULL
        AND i."saleId" IS NOT NULL
        ${tenantClause}
    `;

    const ledSale = await prisma.$executeRaw`
      UPDATE "LedgerEntry" l
      SET "invoiceId" = i.id
      FROM "Invoice" i
      WHERE l."linkedRecordType" = 'sale'
        AND l."linkedRecordId" = i."saleId"
        AND l."invoiceId" IS NULL
        AND l."deletedAt" IS NULL
        AND i."deletedAt" IS NULL
        AND i."saleId" IS NOT NULL
        ${tenantClause}
    `;
    const ledMov = await prisma.$executeRaw`
      UPDATE "LedgerEntry" l
      SET "invoiceId" = i.id
      FROM "Invoice" i
      WHERE l."linkedRecordType" = 'stock_movement'
        AND l."linkedRecordId" = i."stockMovementId"
        AND l."invoiceId" IS NULL
        AND l."deletedAt" IS NULL
        AND i."deletedAt" IS NULL
        AND i."stockMovementId" IS NOT NULL
        ${tenantClause}
    `;
    const ledExp = await prisma.$executeRaw`
      UPDATE "LedgerEntry" l
      SET "invoiceId" = i.id
      FROM "Invoice" i
      WHERE l."linkedRecordType" = 'expense'
        AND l."linkedRecordId" = i."expenseId"
        AND l."invoiceId" IS NULL
        AND l."deletedAt" IS NULL
        AND i."deletedAt" IS NULL
        AND i."expenseId" IS NOT NULL
        ${tenantClause}
    `;
    const ledJob = await prisma.$executeRaw`
      UPDATE "LedgerEntry" l
      SET "invoiceId" = i.id
      FROM "Invoice" i
      WHERE l."linkedRecordType" = 'job'
        AND l."linkedRecordId" = i."jobId"
        AND l."invoiceId" IS NULL
        AND l."deletedAt" IS NULL
        AND i."deletedAt" IS NULL
        AND i."jobId" IS NOT NULL
        AND i.kind = 'job_invoice'
        ${tenantClause}
    `;
    ledgerLinked =
      Number(ledSale) +
      Number(ledMov) +
      Number(ledExp) +
      Number(ledJob);
    console.log(
      `  Linked payments=${paymentsLinked}, accountTx=${acctResult}, ledger=${ledgerLinked}`,
    );
  }

  const stats = {
    sales: salesCreated,
    purchases: purchasesCreated,
    expenses: expensesCreated,
    payrolls: payrollsCreated,
    payrollGroups: groupsCreated,
    jobQuotes: quotesCreated,
    jobInvoices: jobInvsCreated,
    paymentsLinked,
    ledgerLinked,
    skippedExisting: existing.length,
  };

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Invoice backfill complete${tenantCode ? ` (${tenantCode})` : ''}:`,
    stats,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
