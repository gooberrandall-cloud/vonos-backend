import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  InvoiceDetail,
  InvoiceKind,
  InvoiceListRow,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { toIso, toNumber } from '../../common/utils/serializers';

@Injectable()
export class InvoicesService {
  constructor(private readonly tenantDb: TenantDbService) {}

  async list(filters: {
    kind?: InvoiceKind;
    paymentStatus?: string;
    from?: string;
    to?: string;
    search?: string;
    customerId?: string;
    supplierId?: string;
    employeeRecordId?: string;
    saleId?: string;
    stockMovementId?: string;
    expenseId?: string;
    payrollId?: string;
    payrollGroupId?: string;
    jobId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<InvoiceListRow[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'documentDate',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.tenantDb.db.invoice.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.paymentStatus
          ? { paymentStatus: filters.paymentStatus }
          : {}),
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
        ...(filters.employeeRecordId
          ? { employeeRecordId: filters.employeeRecordId }
          : {}),
        ...(filters.saleId ? { saleId: filters.saleId } : {}),
        ...(filters.stockMovementId
          ? { stockMovementId: filters.stockMovementId }
          : {}),
        ...(filters.expenseId ? { expenseId: filters.expenseId } : {}),
        ...(filters.payrollId ? { payrollId: filters.payrollId } : {}),
        ...(filters.payrollGroupId
          ? { payrollGroupId: filters.payrollGroupId }
          : {}),
        ...(filters.jobId ? { jobId: filters.jobId } : {}),
        ...(filters.from || filters.to
          ? {
              documentDate: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
        ...(filters.search
          ? {
              OR: [
                {
                  reference: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
                {
                  contactName: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ documentDate: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });

    return rows.map((row) => this.toListRow(row));
  }

  async getById(id: string): Promise<InvoiceDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    // Single round-trip: unused FK includes come back null (no extra Neon hop).
    const row = await this.tenantDb.db.invoice.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        sale: {
          include: {
            lines: true,
            customer: {
              select: {
                name: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        stockMovement: { include: { supplier: true } },
        expense: { include: { category: true } },
        payroll: { include: { payrollGroup: true, designation: true } },
        payrollGroup: {
          include: {
            payrolls: {
              where: { deletedAt: null },
              take: 200,
            },
          },
        },
        job: {
          include: {
            materials: true,
            labourEntries: true,
            customer: {
              select: {
                name: true,
                email: true,
                phone: true,
              },
            },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Invoice not found');

    const lineItems = this.buildLineItems(
      row as Parameters<InvoicesService['buildLineItems']>[0],
    );
    const linked = this.linkedRecord(row);

    return {
      ...this.toListRow(row),
      subtotal: row.subtotal != null ? toNumber(row.subtotal) : null,
      taxAmount: row.taxAmount != null ? toNumber(row.taxAmount) : null,
      discountAmount:
        row.discountAmount != null ? toNumber(row.discountAmount) : null,
      dueDate: row.dueDate ? toIso(row.dueDate) : null,
      notes: row.notes,
      layoutId: row.layoutId,
      schemeId: row.schemeId,
      lineItems,
      linkedRecordType: linked.type,
      linkedRecordId: linked.id,
    };
  }

  private toListRow(row: {
    id: string;
    tenantId: string;
    reference: string;
    kind: InvoiceKind;
    status: string;
    paymentStatus: string | null;
    currency: string;
    total: { toString(): string };
    documentDate: Date;
    contactName: string | null;
    customerId: string | null;
    supplierId: string | null;
    employeeRecordId: string | null;
    saleId: string | null;
    stockMovementId: string | null;
    expenseId: string | null;
    payrollId: string | null;
    payrollGroupId: string | null;
    jobId: string | null;
    createdAt: Date;
  }): InvoiceListRow {
    return {
      id: row.id,
      tenantId: row.tenantId,
      reference: row.reference,
      kind: row.kind as InvoiceKind,
      status: row.status,
      paymentStatus: row.paymentStatus,
      currency: row.currency,
      total: toNumber(row.total),
      documentDate: toIso(row.documentDate),
      contactName: row.contactName,
      customerId: row.customerId,
      supplierId: row.supplierId,
      employeeRecordId: row.employeeRecordId,
      saleId: row.saleId,
      stockMovementId: row.stockMovementId,
      expenseId: row.expenseId,
      payrollId: row.payrollId,
      payrollGroupId: row.payrollGroupId,
      jobId: row.jobId,
      createdAt: toIso(row.createdAt),
    };
  }

  private linkedRecord(row: {
    saleId: string | null;
    stockMovementId: string | null;
    expenseId: string | null;
    payrollId: string | null;
    payrollGroupId: string | null;
    jobId: string | null;
    kind: string;
  }): { type: string | null; id: string | null } {
    if (row.saleId) return { type: 'sale', id: row.saleId };
    if (row.stockMovementId)
      return { type: 'stock_movement', id: row.stockMovementId };
    if (row.expenseId) return { type: 'expense', id: row.expenseId };
    if (row.payrollId) return { type: 'payroll', id: row.payrollId };
    if (row.payrollGroupId)
      return { type: 'payroll_group', id: row.payrollGroupId };
    if (row.jobId) return { type: 'job', id: row.jobId };
    return { type: null, id: null };
  }

  private buildLineItems(row: {
    kind: string;
    sale?: {
      lines: Array<{
        name: string;
        sku: string;
        quantity: { toString(): string };
        unitPrice: { toString(): string };
        lineTotal: { toString(): string };
      }>;
    } | null;
    stockMovement?: {
      lines: unknown;
    } | null;
    expense?: {
      category?: { name: string } | null;
      totalAmount: { toString(): string };
    } | null;
    payroll?: {
      employeeName: string;
      grossPay: { toString(): string };
      totalAllowance: { toString(): string };
      totalDeduction: { toString(): string };
      netPay: { toString(): string };
      designation?: { name: string } | null;
    } | null;
    payrollGroup?: {
      name: string;
      payrolls?: Array<{
        employeeName: string;
        netPay: { toString(): string };
      }>;
    } | null;
    job?: {
      materials: Array<{
        name: string;
        quantity: { toString(): string };
        unitCost: { toString(): string };
        totalCost: { toString(): string };
      }>;
      labourEntries: Array<{
        staffId: string;
        hours: { toString(): string };
        rate: { toString(): string };
        totalCost: { toString(): string };
      }>;
    } | null;
    total: { toString(): string };
  }) {
    if (row.sale?.lines?.length) {
      return row.sale.lines.map((line) => ({
        label: line.name,
        kind: line.sku,
        quantity: toNumber(line.quantity),
        unitPrice: toNumber(line.unitPrice),
        total: toNumber(line.lineTotal),
      }));
    }

    if (row.stockMovement?.lines) {
      const lines = Array.isArray(row.stockMovement.lines)
        ? (row.stockMovement.lines as Array<{
            name?: string;
            sku?: string;
            quantity?: number;
            unitCost?: number;
          }>)
        : [];
      return lines.map((line) => ({
        label: line.name ?? line.sku ?? 'Item',
        kind: line.sku,
        quantity: line.quantity ?? 0,
        unitPrice: line.unitCost ?? 0,
        total: (line.quantity ?? 0) * (line.unitCost ?? 0),
      }));
    }

    if (row.expense) {
      return [
        {
          label: row.expense.category?.name ?? 'Expense',
          quantity: 1,
          unitPrice: toNumber(row.expense.totalAmount),
          total: toNumber(row.expense.totalAmount),
        },
      ];
    }

    if (row.payroll) {
      const items = [
        {
          label: 'Gross pay',
          kind: row.payroll.designation?.name ?? undefined,
          quantity: 1,
          unitPrice: toNumber(row.payroll.grossPay),
          total: toNumber(row.payroll.grossPay),
        },
      ];
      if (toNumber(row.payroll.totalAllowance) > 0) {
        items.push({
          label: 'Allowances',
          kind: undefined,
          quantity: 1,
          unitPrice: toNumber(row.payroll.totalAllowance),
          total: toNumber(row.payroll.totalAllowance),
        });
      }
      if (toNumber(row.payroll.totalDeduction) > 0) {
        items.push({
          label: 'Deductions',
          kind: undefined,
          quantity: 1,
          unitPrice: -toNumber(row.payroll.totalDeduction),
          total: -toNumber(row.payroll.totalDeduction),
        });
      }
      items.push({
        label: 'Net pay',
        kind: undefined,
        quantity: 1,
        unitPrice: toNumber(row.payroll.netPay),
        total: toNumber(row.payroll.netPay),
      });
      return items;
    }

    if (row.payrollGroup) {
      const slips = row.payrollGroup.payrolls ?? [];
      if (slips.length > 0) {
        return slips.map((slip) => ({
          label: slip.employeeName,
          quantity: 1,
          unitPrice: toNumber(slip.netPay),
          total: toNumber(slip.netPay),
        }));
      }
      return [
        {
          label: row.payrollGroup.name,
          quantity: 1,
          unitPrice: toNumber(row.total),
          total: toNumber(row.total),
        },
      ];
    }

    if (row.job) {
      const materialLines = row.job.materials.map((m) => ({
        label: m.name,
        kind: 'Material',
        quantity: toNumber(m.quantity),
        unitPrice: toNumber(m.unitCost),
        total: toNumber(m.totalCost),
      }));
      const labourLines = row.job.labourEntries.map((l) => ({
        label: l.staffId,
        kind: 'Labour',
        quantity: toNumber(l.hours),
        unitPrice: toNumber(l.rate),
        total: toNumber(l.totalCost),
      }));
      return [...materialLines, ...labourLines];
    }

    return [
      {
        label: 'Total',
        quantity: 1,
        unitPrice: toNumber(row.total),
        total: toNumber(row.total),
      },
    ];
  }
}
