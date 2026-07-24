import { Injectable } from '@nestjs/common';
import type { InvoiceKind, Prisma } from '@prisma/client';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { toNumber } from '../../common/utils/serializers';

type DbClient = Prisma.TransactionClient | TenantDbService['db'];

export interface CreateInvoiceInput {
  reference: string;
  kind: InvoiceKind;
  status?: string;
  paymentStatus?: string | null;
  currency?: string;
  subtotal?: number | null;
  taxAmount?: number | null;
  discountAmount?: number | null;
  total: number;
  documentDate: Date;
  dueDate?: Date | null;
  notes?: string | null;
  legacyId?: number | null;
  customerId?: string | null;
  supplierId?: string | null;
  employeeRecordId?: string | null;
  contactName?: string | null;
  saleId?: string | null;
  stockMovementId?: string | null;
  expenseId?: string | null;
  payrollId?: string | null;
  payrollGroupId?: string | null;
  jobId?: string | null;
}

@Injectable()
export class InvoiceHubService {
  constructor(private readonly tenantDb: TenantDbService) {}

  async createInvoice(
    db: DbClient,
    input: CreateInvoiceInput,
    tenantId?: string,
  ) {
    const tid = tenantId ?? this.tenantDb.requireTenantId();
    return db.invoice.create({
      data: {
        tenantId: tid,
        reference: input.reference,
        kind: input.kind,
        status: input.status ?? 'final',
        paymentStatus: input.paymentStatus ?? null,
        currency: input.currency ?? 'NGN',
        subtotal: input.subtotal ?? null,
        taxAmount: input.taxAmount ?? null,
        discountAmount: input.discountAmount ?? null,
        total: input.total,
        documentDate: input.documentDate,
        dueDate: input.dueDate ?? null,
        notes: input.notes ?? null,
        legacyId: input.legacyId ?? null,
        customerId: input.customerId ?? null,
        supplierId: input.supplierId ?? null,
        employeeRecordId: input.employeeRecordId ?? null,
        contactName: input.contactName ?? null,
        saleId: input.saleId ?? null,
        stockMovementId: input.stockMovementId ?? null,
        expenseId: input.expenseId ?? null,
        payrollId: input.payrollId ?? null,
        payrollGroupId: input.payrollGroupId ?? null,
        jobId: input.jobId ?? null,
      },
    });
  }

  async findBySaleId(db: DbClient, saleId: string) {
    return db.invoice.findFirst({
      where: { saleId, deletedAt: null },
    });
  }

  async findByStockMovementId(db: DbClient, stockMovementId: string) {
    return db.invoice.findFirst({
      where: { stockMovementId, deletedAt: null },
    });
  }

  async findByExpenseId(db: DbClient, expenseId: string) {
    return db.invoice.findFirst({
      where: { expenseId, deletedAt: null },
    });
  }

  async findByPayrollId(db: DbClient, payrollId: string) {
    return db.invoice.findFirst({
      where: { payrollId, deletedAt: null },
    });
  }

  async findByPayrollGroupId(db: DbClient, payrollGroupId: string) {
    return db.invoice.findFirst({
      where: { payrollGroupId, deletedAt: null },
    });
  }

  async findJobInvoice(
    db: DbClient,
    jobId: string,
    kind: 'job_invoice' | 'job_quote',
  ) {
    return db.invoice.findFirst({
      where: { jobId, kind, deletedAt: null },
    });
  }

  async ensureSaleInvoice(
    db: DbClient,
    sale: {
      id: string;
      tenantId: string;
      reference: string;
      customerId: string | null;
      customer?: { name: string } | null;
      jobId?: string | null;
      total: { toString(): string } | number;
      discountAmount?: { toString(): string } | number | null;
      taxAmount?: { toString(): string } | number | null;
      currency: string;
      status: string;
      paymentStatus: string | null;
      date: Date;
      notes: string | null;
    },
    lines?: Array<{ lineTotal: { toString(): string } | number }>,
  ) {
    const existing = await this.findBySaleId(db, sale.id);
    if (existing) return existing;

    const subtotal =
      lines?.reduce((sum, line) => sum + toNumber(line.lineTotal), 0) ??
      toNumber(sale.total);

    return this.createInvoice(
      db,
      {
        reference: sale.reference,
        kind: 'sale',
        status: sale.status === 'quotation' || sale.status === 'draft' ? sale.status : 'final',
        paymentStatus: sale.paymentStatus,
        currency: sale.currency,
        subtotal,
        taxAmount: sale.taxAmount != null ? toNumber(sale.taxAmount) : null,
        discountAmount:
          sale.discountAmount != null ? toNumber(sale.discountAmount) : null,
        total: toNumber(sale.total),
        documentDate: sale.date,
        notes: sale.notes,
        customerId: sale.customerId,
        contactName: sale.customer?.name ?? null,
        saleId: sale.id,
        jobId: sale.jobId ?? null,
      },
      sale.tenantId,
    );
  }

  async ensurePurchaseInvoice(
    db: DbClient,
    movement: {
      id: string;
      tenantId: string;
      reference: string;
      type: string;
      status: string;
      paymentStatus: string | null;
      supplierId: string | null;
      supplier?: { name: string } | null;
      date: Date;
      notes: string | null;
      lines: unknown;
    },
  ) {
    if (movement.type !== 'inbound') return null;

    const existing = await this.findByStockMovementId(db, movement.id);
    if (existing) return existing;

    const lines = Array.isArray(movement.lines)
      ? (movement.lines as Array<{ quantity?: number; unitCost?: number }>)
      : [];
    const total = lines.reduce(
      (sum, line) => sum + (line.quantity ?? 0) * (line.unitCost ?? 0),
      0,
    );

    return this.createInvoice(
      db,
      {
        reference: movement.reference,
        kind: 'purchase',
        status: movement.status.toLowerCase(),
        paymentStatus: movement.paymentStatus,
        total,
        subtotal: total,
        documentDate: movement.date,
        notes: movement.notes,
        supplierId: movement.supplierId,
        contactName: movement.supplier?.name ?? null,
        stockMovementId: movement.id,
      },
      movement.tenantId,
    );
  }

  async ensureExpenseInvoice(
    db: DbClient,
    expense: {
      id: string;
      tenantId: string;
      refNo: string | null;
      totalAmount: { toString(): string } | number;
      taxAmount: { toString(): string } | number;
      paymentStatus: string;
      expenseDate: Date;
      note: string | null;
      expenseForCustomerId: string | null;
      contactName: string | null;
    },
  ) {
    const existing = await this.findByExpenseId(db, expense.id);
    if (existing) return existing;

    const reference =
      expense.refNo?.trim() || `EXP-${expense.id.slice(-8).toUpperCase()}`;

    return this.createInvoice(
      db,
      {
        reference,
        kind: 'expense',
        status: 'final',
        paymentStatus: expense.paymentStatus,
        total: toNumber(expense.totalAmount),
        taxAmount: toNumber(expense.taxAmount),
        subtotal: toNumber(expense.totalAmount),
        documentDate: expense.expenseDate,
        notes: expense.note,
        customerId: expense.expenseForCustomerId,
        contactName: expense.contactName,
        expenseId: expense.id,
      },
      expense.tenantId,
    );
  }

  async ensurePayrollInvoice(
    db: DbClient,
    payroll: {
      id: string;
      tenantId: string;
      employeeName: string;
      employeeRecordId: string | null;
      netPay: { toString(): string } | number;
      grossPay: { toString(): string } | number;
      paymentStatus: string;
      status: string;
      payrollMonth: Date;
      note: string | null;
      payrollGroup?: { name: string } | null;
    },
  ) {
    const existing = await this.findByPayrollId(db, payroll.id);
    if (existing) return existing;

    const month = payroll.payrollMonth.toISOString().slice(0, 7);
    const reference = `PAY-${month}-${payroll.employeeName.replace(/\s+/g, '-').slice(0, 24)}-${payroll.id.slice(-6)}`;

    return this.createInvoice(
      db,
      {
        reference,
        kind: 'payroll',
        status: payroll.status,
        paymentStatus: payroll.paymentStatus,
        total: toNumber(payroll.netPay),
        subtotal: toNumber(payroll.grossPay),
        documentDate: payroll.payrollMonth,
        notes: payroll.note,
        employeeRecordId: payroll.employeeRecordId,
        contactName: payroll.employeeName,
        payrollId: payroll.id,
      },
      payroll.tenantId,
    );
  }

  async ensurePayrollGroupInvoice(
    db: DbClient,
    group: {
      id: string;
      tenantId: string;
      name: string;
      createdAt: Date;
    },
    grossTotal?: number,
  ) {
    const existing = await this.findByPayrollGroupId(db, group.id);
    if (existing) return existing;

    const reference = `PG-${group.id.slice(-10)}`;
    return this.createInvoice(
      db,
      {
        reference,
        kind: 'payroll_group',
        status: 'final',
        paymentStatus: 'due',
        total: grossTotal ?? 0,
        subtotal: grossTotal ?? 0,
        documentDate: group.createdAt,
        contactName: group.name,
        payrollGroupId: group.id,
      },
      group.tenantId,
    );
  }

  async ensureJobDocumentInvoice(
    db: DbClient,
    job: {
      id: string;
      tenantId: string;
      reference: string;
      customerId: string | null;
      customerName: string | null;
      hasQuote: boolean;
      quoteAmount: { toString(): string } | number | null;
      quoteNotes: string | null;
      quoteValidUntil: Date | null;
      invoiceAmount: { toString(): string } | number | null;
      invoiceNotes: string | null;
      createdAt: Date;
    },
    kind: 'job_quote' | 'job_invoice',
  ) {
    const existing = await this.findJobInvoice(db, job.id, kind);
    const isQuote = kind === 'job_quote';
    const amount = isQuote ? job.quoteAmount : job.invoiceAmount;
    if (amount == null && !isQuote && !job.hasQuote) return null;
    if (isQuote && !job.hasQuote && job.quoteAmount == null) return null;

    const total = amount != null ? toNumber(amount) : 0;
    const reference = isQuote ? `${job.reference}-Q` : `${job.reference}-INV`;

    if (existing) {
      return db.invoice.update({
        where: { id: existing.id },
        data: {
          total,
          subtotal: total,
          dueDate: isQuote ? job.quoteValidUntil : null,
          notes: isQuote ? job.quoteNotes : job.invoiceNotes,
        },
      });
    }

    return this.createInvoice(
      db,
      {
        reference,
        kind,
        status: 'final',
        paymentStatus: 'due',
        total,
        subtotal: total,
        documentDate: job.createdAt,
        dueDate: isQuote ? job.quoteValidUntil : null,
        notes: isQuote ? job.quoteNotes : job.invoiceNotes,
        customerId: job.customerId,
        contactName: job.customerName,
        jobId: job.id,
      },
      job.tenantId,
    );
  }

  async linkLedgerToInvoice(
    db: DbClient,
    invoiceId: string,
    linkedRecordType: string,
    linkedRecordId: string,
  ) {
    await db.ledgerEntry.updateMany({
      where: {
        linkedRecordType,
        linkedRecordId,
        deletedAt: null,
        invoiceId: null,
      },
      data: { invoiceId },
    });
  }

  async linkPaymentsToSaleInvoice(db: DbClient, saleId: string, invoiceId: string) {
    await db.payment.updateMany({
      where: { saleId, deletedAt: null, invoiceId: null },
      data: { invoiceId },
    });
    await db.accountTransaction.updateMany({
      where: { saleId, deletedAt: null, invoiceId: null },
      data: { invoiceId },
    });
  }
}
