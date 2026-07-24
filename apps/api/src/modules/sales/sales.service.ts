import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  CsvImportResult,
  PaymentStatus,
  Sale,
  SaleDetail,
  SaleFilters,
  SaleLine,
  SaleStatus,
  SaleViewBundle,
} from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { refreshCustomerFinancialRollups } from '../../common/utils/customerRollups';
import { applyDailyFinanceDelta } from '../../common/utils/dailyFinanceRollup';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import { AuditService } from '../audit/audit.service';
import { InvoiceHubService } from '../invoices/invoice-hub.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import type { PaginatedList } from '../../common/utils/paginatedList';
import { resolveListSort } from '../../common/utils/listSort';
import { computeStockStatus, movementLineRollups } from '../../common/utils/stockQuantity';
import { adjustItemLocationStock } from '../../common/utils/itemLocationStock';
import {
  parseCsv,
  pickCsvField,
} from '../../common/utils/csvImport';
import {
  mapSaleStatusToUi,
  saleStatusWhereClause,
  toIso,
  toNumber,
} from '../../common/utils/serializers';
import { encodePublicInvoiceToken } from '../../common/utils/publicInvoiceToken';

function normalizeCreateStatus(
  status?: SaleStatus | 'final',
): SaleStatus {
  if (!status || status === 'final') return 'completed';
  return status;
}

type SaleLineInput = {
  itemId?: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  createPurchase?: boolean;
  sourceTenantCode?: string;
};

function computeLineTotal(line: {
  quantity: number;
  unitPrice: number;
  discountAmount?: number | null;
}): number {
  const discount = line.discountAmount ?? 0;
  return Math.max(0, line.quantity * line.unitPrice - discount);
}

function buildSaleLineRows(lines: SaleLineInput[]) {
  return lines.map((line) => {
    const discountAmount = line.discountAmount ?? 0;
    const lineTotal = computeLineTotal({ ...line, discountAmount });
    return {
      itemId: line.itemId ?? null,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal,
      discountAmount: discountAmount > 0 ? discountAmount : null,
    };
  });
}

function computeSaleTotal(
  lineRows: Array<{ lineTotal: number }>,
  orderDiscount = 0,
  taxAmount = 0,
): number {
  const subtotal = lineRows.reduce((sum, line) => sum + line.lineTotal, 0);
  const discount = Math.min(subtotal, Math.max(0, orderDiscount));
  const tax = Math.max(0, taxAmount);
  return Math.max(0, subtotal - discount + tax);
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cache: CacheService,
    private readonly invoiceHub: InvoiceHubService,
  ) {}

  private refreshSaleSideEffects(options: {
    customerId?: string | null;
    ledgerEntry?: {
      type: 'revenue' | 'expense';
      amount: number;
      date: Date;
      currency?: string;
    };
  }): void {
    const tenantId = this.tenantDb.requireTenantId();
    void invalidateTenantDashboardCache(this.cache, tenantId);
    if (options.ledgerEntry) {
      void applyDailyFinanceDelta(
        this.prisma,
        tenantId,
        options.ledgerEntry.date,
        options.ledgerEntry.type,
        Math.abs(options.ledgerEntry.amount),
        options.ledgerEntry.currency ?? 'NGN',
      );
    }
    if (options.customerId) {
      void refreshCustomerFinancialRollups(this.tenantDb.db, options.customerId);
    }
  }

  async list(filters: SaleFilters): Promise<PaginatedList<Sale>> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      from: filters.from,
      to: filters.to,
      locationCode: filters.locationCode,
      customerId: filters.customerId,
      jobId: filters.jobId,
      paymentStatus: filters.paymentStatus,
      paymentMethod: filters.paymentMethod,
      cleanerUserId: filters.cleanerUserId,
      serviceStaffEmployeeId: filters.serviceStaffEmployeeId,
      createdByUserId: filters.createdByUserId,
      status: filters.status,
      saleStatus: filters.saleStatus,
      returnsOnly: filters.returnsOnly ? 1 : 0,
      shipmentsOnly: filters.shipmentsOnly ? 1 : 0,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
      sum: filters.includeSummary === false ? 0 : 1,
    });

    return withListPageCache(
      this.cache,
      tenantId,
      'sales',
      filterKey,
      () => this.listUncached(filters, tenantId),
    );
  }

  private async listUncached(
    filters: SaleFilters,
    tenantId: string,
  ): Promise<PaginatedList<Sale>> {
    const startedAt = Date.now();
    const dateFilter =
      filters.from || filters.to
        ? {
            date: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {};
    const sort = resolveListSort(filters.sortBy, filters.sortDir, {
      date: { field: 'date', type: 'date' },
      reference: { field: 'reference', type: 'string' },
      total: { field: 'total', type: 'number' },
      paymentStatus: { field: 'paymentStatus', type: 'string' },
      status: { field: 'status', type: 'string' },
      createdAt: { field: 'createdAt', type: 'date' },
    }, {
      sortField: 'date',
      sortDir: 'desc',
      sortValueType: 'date',
    });
    const pagination = buildCompositeCursorQuery({
      sortField: sort.sortField,
      sortDir: sort.sortDir,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: sort.sortValueType,
    });

    // Prefer reference-only search when query looks like a sale # (avoids customer join).
    const search = filters.search?.trim();
    const searchLooksLikeRef =
      Boolean(search) && /^[A-Za-z0-9._-]{2,}$/.test(search!);

    const baseWhere = {
      tenantId,
      deletedAt: null,
      ...saleStatusWhereClause(filters),
      ...dateFilter,
      ...(filters.locationCode ? { locationCode: filters.locationCode } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.paymentStatus
        ? { paymentStatus: filters.paymentStatus }
        : {}),
      ...(filters.paymentMethod
        ? { paymentMethod: filters.paymentMethod }
        : {}),
      ...(filters.cleanerUserId
        ? { cleanerUserId: filters.cleanerUserId }
        : {}),
      ...(filters.serviceStaffEmployeeId
        ? { serviceStaffEmployeeId: filters.serviceStaffEmployeeId }
        : {}),
      ...(filters.createdByUserId
        ? { createdByUserId: filters.createdByUserId }
        : {}),
      ...(search
        ? searchLooksLikeRef
          ? {
              reference: { contains: search, mode: 'insensitive' as const },
            }
          : {
              OR: [
                {
                  reference: { contains: search, mode: 'insensitive' as const },
                },
                {
                  customer: {
                    name: { contains: search, mode: 'insensitive' as const },
                  },
                },
              ],
            }
        : {}),
    };

    // One Neon wave: rows alone, or rows+count+sum when summary requested.
    const includeSummary = filters.includeSummary !== false;
    const [rows, totalCount, saleAmountAgg] = await Promise.all([
      this.tenantDb.db.sale.findMany({
        where: {
          ...baseWhere,
          ...(pagination.where ?? {}),
        },
        select: {
          id: true,
          tenantId: true,
          reference: true,
          customerId: true,
          customer: { select: { name: true, phone: true } },
          jobId: true,
          job: { select: { reference: true } },
          total: true,
          discountAmount: true,
          taxAmount: true,
          notes: true,
          originalSaleId: true,
          currency: true,
          status: true,
          paymentStatus: true,
          paymentMethod: true,
          cleanerUserId: true,
          cleanerName: true,
          serviceStaffEmployeeId: true,
          serviceStaffEmployee: { select: { name: true } },
          locationCode: true,
          shippingStatus: true,
          shippingAddress: true,
          trackingNumber: true,
          date: true,
          createdByUserId: true,
          createdByName: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ [sort.sortField]: sort.sortDir }, { id: sort.sortDir }],
        take: pagination.take,
      }),
      includeSummary
        ? this.tenantDb.db.sale.count({ where: baseWhere })
        : Promise.resolve(undefined as number | undefined),
      includeSummary
        ? this.tenantDb.db.sale.aggregate({
            where: baseWhere,
            _sum: { total: true },
          })
        : Promise.resolve(undefined),
    ]);

    if (!includeSummary || totalCount == null || saleAmountAgg == null) {
      return {
        items: rows.map((row) => this.toSale(row)),
      };
    }

    const totalAmount = toNumber(saleAmountAgg._sum.total);
    // Paid/due for the filtered set: prefer page-accurate math when this page is the full set;
    // otherwise leave paid/due unset so the UI shows Total from amountSummary + page paid/due.
    let totalPaid: number | undefined;
    let totalDue: number | undefined;
    if (rows.length >= totalCount) {
      totalPaid = 0;
      totalDue = 0;
      for (const row of rows) {
        const mapped = this.toSale(row);
        totalPaid += mapped.totalPaid ?? 0;
        totalDue += mapped.sellDue ?? 0;
      }
    }

    const ms = Date.now() - startedAt;
    if (ms > 500) {
      this.logger.warn(
        `list ${ms}ms tenant=${tenantId} rows=${rows.length} search=${search ? '1' : '0'}`,
      );
    }

    return {
      items: rows.map((row) => this.toSale(row)),
      totalCount,
      amountSummary: {
        totalAmount,
        totalPaid,
        totalDue,
        currency: 'NGN',
      },
    };
  }

  async getById(id: string): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        customer: {
          select: {
            name: true,
            email: true,
            phone: true,
            totalSellDue: true,
          },
        },
        job: { select: { reference: true, vehicleId: true, createdAt: true } },
        serviceStaffEmployee: { select: { name: true } },
        lines: true,
        originalSale: { select: { reference: true } },
        payments: {
          where: { deletedAt: null },
          select: { amount: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Sale not found');

    let vehicleLabel: string | null = null;
    if (row.job?.vehicleId) {
      const vehicle = await this.tenantDb.db.vehicle.findFirst({
        where: {
          id: row.job.vehicleId,
          tenantId,
          deletedAt: null,
        },
        select: { make: true, model: true, plateNumber: true },
      });
      if (vehicle) {
        vehicleLabel = `${vehicle.make}-${vehicle.model} ${vehicle.plateNumber}`.trim();
      }
    }

    return this.toSaleDetail({
      ...row,
      job: row.job
        ? { reference: row.job.reference, vehicleLabel }
        : null,
    });
  }

  /** Modal bundle: sale + payments + activity in one HTTP round-trip (sequential DB). */
  async getView(id: string): Promise<SaleViewBundle> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        customer: {
          select: {
            name: true,
            email: true,
            phone: true,
            totalSellDue: true,
          },
        },
        job: { select: { reference: true, vehicleId: true, createdAt: true } },
        serviceStaffEmployee: { select: { name: true } },
        lines: true,
        originalSale: { select: { reference: true } },
        payments: {
          where: { deletedAt: null, isReturn: false },
          include: { account: { select: { name: true } } },
          orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
        },
      },
    });
    if (!row) throw new NotFoundException('Sale not found');

    let vehicleLabel: string | null = null;
    if (row.job?.vehicleId) {
      const vehicle = await this.tenantDb.db.vehicle.findFirst({
        where: {
          id: row.job.vehicleId,
          tenantId,
          deletedAt: null,
        },
        select: { make: true, model: true, plateNumber: true },
      });
      if (vehicle) {
        vehicleLabel = `${vehicle.make}-${vehicle.model} ${vehicle.plateNumber}`.trim();
      }
    }

    const sale = this.toSaleDetail({
      ...row,
      payments: row.payments.map((p) => ({ amount: p.amount })),
      job: row.job
        ? { reference: row.job.reference, vehicleLabel }
        : null,
    });

    const payments = row.payments.map((payment) => ({
      id: payment.id,
      amount: toNumber(payment.amount),
      currency: payment.currency,
      method: payment.method,
      paymentRefNo: payment.paymentRefNo,
      paidOn: payment.paidOn ? toIso(payment.paidOn) : null,
      note: payment.note,
      accountId: payment.accountId,
      accountName: payment.account?.name ?? null,
      createdByName: payment.createdByName,
    }));

    const activities = await this.auditService.list({
      entityType: 'sale',
      entityId: id,
      limit: 20,
    });

    return { sale, payments, activities };
  }

  async getMeta(id: string): Promise<{ id: string; reference: string }> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, reference: true },
    });
    if (!row) throw new NotFoundException('Sale not found');
    return row;
  }

  async create(body: {
    reference: string;
    customerName?: string;
    customerId?: string;
    jobId?: string;
    locationCode?: string;
    paymentMethod?: string;
    cleanerUserId?: string;
    cleanerName?: string;
    serviceStaffEmployeeId?: string;
    lines: SaleLineInput[];
    currency?: string;
    date?: string;
    status?: SaleStatus | 'final';
    shippingStatus?: string;
    shippingAddress?: string;
    trackingNumber?: string;
    discountAmount?: number;
    taxAmount?: number;
    notes?: string;
    payments?: Array<{
      amount: number;
      method?: string;
      note?: string;
      accountId?: string;
    }>;
  }): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { archetype: true, code: true },
    });
    const isJobTenant = tenant?.archetype === 'job';

    const createdBy = await this.auditService.createdByFields();
    let locationCode = await this.tenantDb.resolveBusinessLocation(
      body.locationCode,
    );
    const currency = body.currency ?? 'NGN';
    const saleDate = body.date ? new Date(body.date) : new Date();
    const status = normalizeCreateStatus(body.status);
    const isProvisional = status === 'draft' || status === 'quotation';

    let jobId: string | null = body.jobId?.trim() || null;
    let jobReference: string | null = null;
    let linkedJob: {
      id: string;
      reference: string;
      customerId: string | null;
      customerName: string | null;
      locationCode: string | null;
      invoiceAmount: { toString(): string } | null;
      materials: Array<{
        itemId: string | null;
        name: string;
        quantity: { toString(): string };
        unitCost: { toString(): string };
      }>;
      labourEntries: Array<{
        hours: { toString(): string };
        rate: { toString(): string };
        totalCost: { toString(): string };
        staffId: string;
      }>;
    } | null = null;

    if (isJobTenant && !jobId) {
      throw new BadRequestException(
        'Select a job — for Automotive, every sale is linked to a job',
      );
    }

    if (jobId) {
      linkedJob = await this.tenantDb.db.job.findFirst({
        where: { id: jobId, tenantId, deletedAt: null },
        select: {
          id: true,
          reference: true,
          customerId: true,
          customerName: true,
          locationCode: true,
          invoiceAmount: true,
          materials: {
            select: {
              itemId: true,
              name: true,
              quantity: true,
              unitCost: true,
            },
          },
          labourEntries: {
            select: {
              hours: true,
              rate: true,
              totalCost: true,
              staffId: true,
            },
          },
        },
      });
      if (!linkedJob) {
        throw new BadRequestException('Job not found');
      }
      jobReference = linkedJob.reference;
      const existingForJob = await this.tenantDb.db.sale.findFirst({
        where: { tenantId, jobId, deletedAt: null },
        select: { id: true, reference: true },
      });
      if (existingForJob) {
        throw new BadRequestException(
          `Job ${linkedJob.reference} already has sale ${existingForJob.reference}`,
        );
      }
      if (!locationCode && linkedJob.locationCode) {
        locationCode = linkedJob.locationCode;
      }
    }

    let serviceStaffEmployeeId: string | null = null;
    let cleanerUserId = body.cleanerUserId?.trim() || null;
    let cleanerName = body.cleanerName?.trim() || null;

    if (body.serviceStaffEmployeeId?.trim()) {
      const employee = await this.tenantDb.db.employee.findFirst({
        where: {
          id: body.serviceStaffEmployeeId.trim(),
          tenantId,
          deletedAt: null,
          isServiceStaff: true,
        },
        select: { id: true, name: true, userId: true },
      });
      if (!employee) {
        throw new BadRequestException('Service staff employee not found');
      }
      serviceStaffEmployeeId = employee.id;
      cleanerName = cleanerName || employee.name;
      cleanerUserId = cleanerUserId || employee.userId;
    }

    let customerId: string | null = null;
    if (body.customerId?.trim()) {
      const existing = await this.tenantDb.db.customer.findFirst({
        where: { id: body.customerId.trim(), tenantId, deletedAt: null },
      });
      if (!existing) {
        throw new BadRequestException('Customer not found');
      }
      customerId = existing.id;
    } else if (linkedJob?.customerId) {
      customerId = linkedJob.customerId;
    } else if (body.customerName?.trim() || linkedJob?.customerName?.trim()) {
      const name = (body.customerName ?? linkedJob?.customerName ?? '').trim();
      const existing = await this.tenantDb.db.customer.findFirst({
        where: {
          tenantId,
          deletedAt: null,
          name: { equals: name, mode: 'insensitive' },
        },
      });
      if (existing) {
        customerId = existing.id;
      } else if (name) {
        const customer = await this.tenantDb.db.customer.create({
          data: {
            tenantId,
            name,
            ...createdBy,
          },
        });
        customerId = customer.id;
      }
    }

    let workingLines: SaleLineInput[] = body.lines.map((line) => ({ ...line }));
    if (workingLines.length === 0 && linkedJob) {
      workingLines = this.linesFromJob(linkedJob);
    }
    if (workingLines.length === 0) {
      throw new BadRequestException('Add at least one line item');
    }

    const orderDiscount = body.discountAmount ?? 0;
    const taxAmount = body.taxAmount ?? 0;
    /** Job materials already moved stock — do not deduct again on the sale. */
    const skipStock = Boolean(jobId);

    const paymentRows =
      !isProvisional && body.payments && body.payments.length > 0
        ? body.payments
        : isProvisional
          ? []
          : [{ amount: 0, method: 'cash' }];

    const saleReference =
      body.reference?.trim() ||
      (jobReference ? jobReference : `SALE-${Date.now().toString(36).toUpperCase()}`);

    const row = await this.prisma.$transaction(async (tx) => {
      if (!isProvisional && !skipStock) {
        for (let index = 0; index < workingLines.length; index++) {
          const line = workingLines[index]!;
          const qty = Math.max(1, Math.round(line.quantity));
          const needsPurchase = Boolean(line.createPurchase) || !line.itemId;
          if (!needsPurchase) continue;

          const sku =
            line.sku?.trim() ||
            `ADHOC-${Date.now().toString(36).toUpperCase()}-${index + 1}`;
          let item = await tx.item.findFirst({
            where: { tenantId, sku, deletedAt: null },
          });
          if (!item) {
            item = await tx.item.create({
              data: {
                tenantId,
                sku,
                name: line.name.trim(),
                quantity: qty,
                costPrice: line.unitPrice,
                sellPrice: line.unitPrice,
                status: computeStockStatus(qty, null),
                locationCode: locationCode ?? undefined,
              },
            });
          } else {
            const nextQty = toNumber(item.quantity) + qty;
            item = await tx.item.update({
              where: { id: item.id },
              data: {
                quantity: nextQty,
                status: computeStockStatus(nextQty, item.reorderPoint),
              },
            });
          }

          const purchaseLineTotal = qty * line.unitPrice;
          const purchaseLines = [
            {
              itemId: item.id,
              name: line.name,
              quantity: qty,
              unitCost: line.unitPrice,
              total: purchaseLineTotal,
            },
          ];
          const purchaseRollups = movementLineRollups(purchaseLines);
          await tx.stockMovement.create({
            data: {
              tenantId,
              type: 'inbound',
              reference: `${body.reference}-P${index + 1}`,
              status: 'Received',
              locationCode: locationCode ?? undefined,
              paymentStatus: 'due',
              lines: purchaseLines,
              itemCount: purchaseRollups.itemCount,
              grandTotal: purchaseRollups.grandTotal,
              notes: `Ad-hoc purchase for sale ${body.reference}`,
              date: saleDate,
              ...createdBy,
            },
          });

          workingLines[index] = { ...line, itemId: item.id, sku, quantity: qty };
        }

        for (const line of workingLines) {
          if (!line.itemId) continue;
          const item = await tx.item.findFirst({
            where: { id: line.itemId, deletedAt: null },
          });
          if (!item) {
            throw new BadRequestException(`Item not found: ${line.sku}`);
          }
          const qty = Math.max(1, Math.round(line.quantity));
          const currentQty = toNumber(item.quantity);
          const nextQuantity = currentQty - qty;
          await tx.item.update({
            where: { id: item.id },
            data: {
              quantity: nextQuantity,
              status: computeStockStatus(nextQuantity, item.reorderPoint),
            },
          });
          await adjustItemLocationStock(tx, {
            tenantId: item.tenantId,
            itemId: item.id,
            locationCode: locationCode ?? item.locationCode,
            binLocation: item.binLocation,
            delta: -qty,
          });
        }
      }

      const lineData = buildSaleLineRows(workingLines);
      const total = computeSaleTotal(lineData, orderDiscount, taxAmount);

      const resolvedPayments =
        !isProvisional && body.payments && body.payments.length > 0
          ? body.payments
          : isProvisional
            ? []
            : [{ amount: total, method: 'cash' as const }];
      const paidTotal = resolvedPayments.reduce((sum, row) => sum + row.amount, 0);
      let paymentStatus: PaymentStatus | null = isProvisional ? 'due' : 'paid';
      if (!isProvisional) {
        if (paidTotal <= 0) paymentStatus = 'due';
        else if (paidTotal < total) paymentStatus = 'partial';
      }

      const sale = await tx.sale.create({
        data: {
          tenantId,
          reference: saleReference,
          customerId,
          jobId,
          total,
          discountAmount: orderDiscount > 0 ? orderDiscount : null,
          taxAmount: taxAmount > 0 ? taxAmount : null,
          notes: body.notes?.trim() || null,
          currency,
          status,
          paymentStatus,
          paymentMethod: body.paymentMethod?.trim() || null,
          cleanerUserId,
          cleanerName,
          serviceStaffEmployeeId,
          locationCode,
          shippingStatus: body.shippingStatus ?? (isProvisional ? null : 'pending'),
          shippingAddress: body.shippingAddress?.trim() || null,
          trackingNumber: body.trackingNumber?.trim() || null,
          date: saleDate,
          lines: { create: lineData },
          ...createdBy,
        },
        include: {
          customer: true,
          job: { select: { reference: true } },
          lines: true,
        },
      });

      const invoice = await this.invoiceHub.ensureSaleInvoice(
        tx,
        sale,
        sale.lines,
      );

      if (jobId && !isProvisional) {
        await tx.job.update({
          where: { id: jobId },
          data: {
            invoiceAmount: total,
            ...(customerId ? { customerId } : {}),
          },
        });
      }

      if (!isProvisional) {
        await tx.ledgerEntry.create({
          data: {
            tenantId,
            type: 'revenue',
            amount: total,
            currency,
            category: 'Sales',
            description: `Sale ${sale.reference}`,
            linkedRecordType: 'sale',
            linkedRecordId: sale.id,
            invoiceId: invoice.id,
            date: saleDate,
          },
        });

        for (const payment of resolvedPayments) {
          if (payment.amount <= 0) continue;
          await tx.payment.create({
            data: {
              tenantId,
              amount: payment.amount,
              currency,
              method: payment.method ?? 'cash',
              paymentRefNo: `SP${saleDate.getFullYear()}/${sale.reference}`,
              paidOn: saleDate,
              paymentFor: 'sale',
              saleId: sale.id,
              invoiceId: invoice.id,
              accountId: payment.accountId ?? null,
              note: payment.note ?? null,
              createdByName: createdBy.createdByName ?? null,
            },
          });
        }
      }

      return sale;
    });

    const saleTotal = toNumber(row.total);
    await this.auditService.log({
      action: 'created',
      entityType: 'sale',
      entityId: row.id,
      summary: `Recorded sale ${row.reference}`,
      metadata: { total: saleTotal, paymentStatus: row.paymentStatus },
    });

    this.refreshSaleSideEffects({
      customerId: row.customerId,
      ledgerEntry: !isProvisional
        ? {
            type: 'revenue',
            amount: saleTotal,
            date: row.date,
            currency,
          }
        : undefined,
    });

    return this.toSaleDetail(row);
  }

  /** Convert a draft or quotation into a completed sale (stock + ledger + payments). */
  async finalize(
    id: string,
    body: {
      payments?: Array<{
        amount: number;
        method?: string;
        note?: string;
        accountId?: string;
      }>;
    } = {},
  ): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { customer: true, lines: true },
    });
    if (!existing) throw new NotFoundException('Sale not found');
    if (existing.status !== 'draft' && existing.status !== 'quotation') {
      throw new BadRequestException('Only drafts and quotations can be finalized');
    }

    const total = toNumber(existing.total);
    const paymentRows =
      body.payments && body.payments.length > 0
        ? body.payments
        : [{ amount: total, method: 'cash' }];
    const paidTotal = paymentRows.reduce((sum, row) => sum + row.amount, 0);
    let paymentStatus: PaymentStatus = 'paid';
    if (paidTotal <= 0) paymentStatus = 'due';
    else if (paidTotal < total) paymentStatus = 'partial';

    const row = await this.prisma.$transaction(async (tx) => {
      if (!existing.jobId) {
        for (const line of existing.lines) {
          if (!line.itemId) continue;
          const item = await tx.item.findFirst({
            where: { id: line.itemId, deletedAt: null },
          });
          if (!item) {
            throw new BadRequestException(`Item not found: ${line.sku}`);
          }
          const currentQty = toNumber(item.quantity);
          const qty = toNumber(line.quantity);
          const nextQuantity = currentQty - qty;
          await tx.item.update({
            where: { id: item.id },
            data: {
              quantity: nextQuantity,
              status: computeStockStatus(nextQuantity, item.reorderPoint),
            },
          });
          await adjustItemLocationStock(tx, {
            tenantId: item.tenantId,
            itemId: item.id,
            locationCode: existing.locationCode ?? item.locationCode,
            binLocation: item.binLocation,
            delta: -qty,
          });
        }
      }

      const sale = await tx.sale.update({
        where: { id },
        data: {
          status: 'completed',
          paymentStatus,
          shippingStatus: existing.shippingStatus ?? 'pending',
        },
        include: {
          customer: true,
          job: { select: { reference: true } },
          lines: true,
        },
      });

      if (existing.jobId) {
        await tx.job.update({
          where: { id: existing.jobId },
          data: { invoiceAmount: total },
        });
      }

      await tx.ledgerEntry.create({
        data: {
          tenantId,
          type: 'revenue',
          amount: total,
          currency: existing.currency,
          category: 'Sales',
          description: `Sale ${sale.reference}`,
          linkedRecordType: 'sale',
          linkedRecordId: sale.id,
          date: existing.date,
        },
      });

      for (const payment of paymentRows) {
        if (payment.amount <= 0) continue;
        await tx.payment.create({
          data: {
            tenantId,
            amount: payment.amount,
            currency: existing.currency,
            method: payment.method ?? 'cash',
            paymentRefNo: `SP${existing.date.getFullYear()}/${sale.reference}`,
            paidOn: existing.date,
            paymentFor: 'sale',
            saleId: sale.id,
            accountId: payment.accountId ?? null,
            note: payment.note ?? null,
            createdByName: existing.createdByName ?? null,
          },
        });
      }

      return sale;
    });

    await this.auditService.log({
      action: 'updated',
      entityType: 'sale',
      entityId: id,
      summary: `Finalized sale ${row.reference}`,
      metadata: { paymentStatus },
    });

    this.refreshSaleSideEffects({
      customerId: row.customerId,
      ledgerEntry: {
        type: 'revenue',
        amount: toNumber(row.total),
        date: row.date,
        currency: row.currency,
      },
    });

    return this.toSaleDetail(row);
  }

  /** Record a return against a completed sale (refund, restock, or write-off). */
  async createReturn(
    id: string,
    body: {
      disposition: 'refunded' | 'restocked' | 'written_off';
      notes?: string;
      lines?: Array<{ saleLineId: string; quantity: number }>;
    },
  ): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const createdBy = await this.auditService.createdByFields();
    const original = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { customer: true, lines: true },
    });
    if (!original) throw new NotFoundException('Sale not found');
    if (original.status !== 'completed') {
      throw new BadRequestException('Only completed sales can be returned');
    }
    if (original.originalSaleId) {
      throw new BadRequestException('Returns cannot be created from another return');
    }

    const existingReturn = await this.tenantDb.db.sale.findFirst({
      where: {
        tenantId,
        originalSaleId: id,
        deletedAt: null,
        status: { in: ['refunded', 'partially_refunded', 'written_off'] },
      },
    });
    if (existingReturn) {
      throw new BadRequestException('A return already exists for this sale');
    }

    const returnStatus: SaleStatus =
      body.disposition === 'restocked'
        ? 'partially_refunded'
        : body.disposition === 'written_off'
          ? 'written_off'
          : 'refunded';

    const lineById = new Map(original.lines.map((line) => [line.id, line]));
    const requestedLines =
      body.lines && body.lines.length > 0
        ? body.lines
        : original.lines.map((line) => ({
            saleLineId: line.id,
            quantity: toNumber(line.quantity),
          }));

    const returnLineRows: SaleLineInput[] = [];
    let returnTotal = 0;
    for (const req of requestedLines) {
      const source = lineById.get(req.saleLineId);
      if (!source) {
        throw new BadRequestException(`Unknown sale line: ${req.saleLineId}`);
      }
      const maxQty = toNumber(source.quantity);
      if (!Number.isFinite(req.quantity) || req.quantity <= 0) {
        throw new BadRequestException('Return quantity must be positive');
      }
      if (req.quantity > maxQty) {
        throw new BadRequestException(
          `Return quantity exceeds sold quantity for ${source.sku}`,
        );
      }
      const unitPrice = toNumber(source.unitPrice);
      const lineTotal = unitPrice * req.quantity;
      returnTotal += lineTotal;
      returnLineRows.push({
        itemId: source.itemId ?? undefined,
        sku: source.sku,
        name: source.name,
        quantity: req.quantity,
        unitPrice,
        discountAmount: source.discountAmount
          ? toNumber(source.discountAmount)
          : undefined,
      });
    }

    if (returnLineRows.length === 0) {
      throw new BadRequestException('No lines to return');
    }

    const isFullReturn =
      requestedLines.length === original.lines.length &&
      requestedLines.every((req) => {
        const source = lineById.get(req.saleLineId);
        return source && req.quantity === toNumber(source.quantity);
      });
    if (isFullReturn) {
      returnTotal = toNumber(original.total);
    }

    let reference = `RET-${original.reference}`;
    let suffix = 1;
    while (
      await this.tenantDb.db.sale.findFirst({
        where: { tenantId, reference, deletedAt: null },
      })
    ) {
      reference = `RET-${original.reference}-${suffix}`;
      suffix += 1;
    }

    const saleDate = new Date();
    const lineData = buildSaleLineRows(returnLineRows);
    const notes = body.notes?.trim() || null;

    const row = await this.prisma.$transaction(async (tx) => {
      if (body.disposition === 'restocked') {
        for (const line of returnLineRows) {
          if (!line.itemId) continue;
          const item = await tx.item.findFirst({
            where: { id: line.itemId, deletedAt: null },
          });
          if (!item) {
            throw new BadRequestException(`Item not found: ${line.sku}`);
          }
          const currentQty = toNumber(item.quantity);
          const nextQuantity = currentQty + line.quantity;
          await tx.item.update({
            where: { id: item.id },
            data: {
              quantity: nextQuantity,
              status: computeStockStatus(nextQuantity, item.reorderPoint),
            },
          });
          await adjustItemLocationStock(tx, {
            tenantId,
            itemId: item.id,
            locationCode: original.locationCode ?? item.locationCode,
            binLocation: item.binLocation,
            delta: line.quantity,
          });
        }
      }

      const sale = await tx.sale.create({
        data: {
          tenantId,
          reference,
          originalSaleId: original.id,
          customerId: original.customerId,
          total: returnTotal,
          currency: original.currency,
          status: returnStatus,
          paymentStatus: 'paid',
          locationCode: original.locationCode,
          notes,
          date: saleDate,
          lines: { create: lineData },
          ...createdBy,
        },
        include: {
          customer: true,
          lines: true,
          originalSale: { select: { reference: true } },
        },
      });

      const invoice = await this.invoiceHub.ensureSaleInvoice(
        tx,
        sale,
        sale.lines,
      );

      await tx.ledgerEntry.create({
        data: {
          tenantId,
          type: 'expense',
          amount: returnTotal,
          currency: original.currency,
          category: 'Sales Returns',
          description: `Return ${sale.reference} for sale ${original.reference}`,
          linkedRecordType: 'sale',
          linkedRecordId: sale.id,
          invoiceId: invoice.id,
          date: saleDate,
        },
      });

      return sale;
    });

    await this.auditService.log({
      action: 'created',
      entityType: 'sale',
      entityId: row.id,
      summary: `Recorded return ${row.reference} for sale ${original.reference}`,
      metadata: { disposition: body.disposition, total: returnTotal },
    });

    this.refreshSaleSideEffects({
      customerId: row.customerId,
      ledgerEntry: {
        type: 'expense',
        amount: returnTotal,
        date: row.date,
        currency: row.currency,
      },
    });

    return this.toSaleDetail(row);
  }

  async updateShipping(
    id: string,
    body: {
      shippingStatus?: string | null;
      shippingAddress?: string | null;
      trackingNumber?: string | null;
    },
  ): Promise<SaleDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Sale not found');

    const row = await this.tenantDb.db.sale.update({
      where: { id },
      data: {
        shippingStatus: body.shippingStatus ?? undefined,
        shippingAddress: body.shippingAddress ?? undefined,
        trackingNumber: body.trackingNumber ?? undefined,
      },
      include: { customer: true, lines: true },
    });

    return this.toSaleDetail(row);
  }

  /** Soft-delete a sale (HQ6 list “Delete” → Are you sure?). */
  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, reference: true, customerId: true },
    });
    if (!existing) throw new NotFoundException('Sale not found');

    await this.tenantDb.db.sale.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.tenantDb.db.payment.updateMany({
      where: { tenantId, saleId: id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    if (existing.customerId) {
      await refreshCustomerFinancialRollups(
        this.tenantDb.db,
        existing.customerId,
      );
    }

    await invalidateTenantDashboardCache(this.cache, tenantId);
    await this.auditService.log({
      action: 'deleted',
      entityType: 'sale',
      entityId: id,
      summary: `Deleted sale ${existing.reference}`,
    });
  }

  async listPayments(id: string): Promise<
    Array<{
      id: string;
      amount: number;
      currency: string;
      method: string | null;
      paymentRefNo: string | null;
      paidOn: string | null;
      note: string | null;
      accountId: string | null;
      accountName: string | null;
      createdByName: string | null;
    }>
  > {
    const tenantId = this.tenantDb.requireTenantId();
    const sale = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!sale) throw new NotFoundException('Sale not found');

    const rows = await this.tenantDb.db.payment.findMany({
      where: { tenantId, saleId: id, deletedAt: null, isReturn: false },
      include: { account: { select: { name: true } } },
      orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      amount: toNumber(row.amount),
      currency: row.currency,
      method: row.method,
      paymentRefNo: row.paymentRefNo,
      paidOn: row.paidOn ? toIso(row.paidOn) : null,
      note: row.note,
      accountId: row.accountId,
      accountName: row.account?.name ?? null,
      createdByName: row.createdByName,
    }));
  }

  /** HQ6 “Invoice URL” share link (public `/invoice/:token`, no login). */
  async getInvoiceShareUrl(id: string): Promise<{ token: string; path: string }> {
    const tenantId = this.tenantDb.requireTenantId();
    const sale = await this.tenantDb.db.sale.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    const token = encodePublicInvoiceToken(sale.id);
    return { token, path: `/invoice/${token}` };
  }

  async importCsv(csv: string): Promise<CsvImportResult> {
    const rows = parseCsv(csv);
    const result: CsvImportResult = { created: 0, updated: 0, errors: [] };

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const sku = pickCsvField(row, 'sku', 'product sku');
      const name = pickCsvField(row, 'name', 'product name', 'product');
      const quantityRaw = pickCsvField(row, 'quantity', 'qty');
      const priceRaw = pickCsvField(row, 'unit_price', 'price', 'unit price');
      const quantity = Number(quantityRaw || '1');
      const unitPrice = Number(priceRaw || '0');
      if (!sku && !name) {
        result.errors.push({
          row: index + 2,
          message: 'SKU or product name is required',
        });
        continue;
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        result.errors.push({ row: index + 2, message: 'Invalid quantity' });
        continue;
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        result.errors.push({ row: index + 2, message: 'Invalid unit price' });
        continue;
      }

      const reference =
        pickCsvField(row, 'reference', 'invoice no', 'invoice') ||
        `IMPORT-${Date.now().toString(36).toUpperCase()}-${index + 1}`;
      const customerName = pickCsvField(row, 'customer', 'customer name') || undefined;
      const dateRaw = pickCsvField(row, 'date', 'sale date');
      const paymentAmount = Number(
        pickCsvField(row, 'payment_amount', 'amount paid', 'paid') || String(quantity * unitPrice),
      );
      const paymentMethod = pickCsvField(row, 'payment_method', 'method') || 'cash';

      let itemId: string | undefined;
      if (sku) {
        const item = await this.tenantDb.db.item.findFirst({
          where: {
            tenantId: this.tenantDb.requireTenantId(),
            deletedAt: null,
            sku: { equals: sku, mode: 'insensitive' },
          },
        });
        itemId = item?.id;
      }

      try {
        await this.create({
          reference,
          customerName,
          date: dateRaw ? new Date(dateRaw).toISOString() : undefined,
          lines: [
            {
              itemId,
              sku: sku || `SKU-${index + 1}`,
              name: name || sku,
              quantity,
              unitPrice,
            },
          ],
          payments: [{ amount: paymentAmount, method: paymentMethod }],
        });
        result.created += 1;
      } catch (error) {
        result.errors.push({
          row: index + 2,
          message: error instanceof Error ? error.message : 'Import failed',
        });
      }
    }

    return result;
  }

  private linesFromJob(job: {
    reference: string;
    invoiceAmount: { toString(): string } | null;
    materials: Array<{
      itemId: string | null;
      name: string;
      quantity: { toString(): string };
      unitCost: { toString(): string };
    }>;
    labourEntries: Array<{
      hours: { toString(): string };
      rate: { toString(): string };
      totalCost: { toString(): string };
      staffId: string;
    }>;
  }): SaleLineInput[] {
    const materialLines = job.materials.map((row, index) => ({
      itemId: row.itemId ?? undefined,
      sku: row.itemId ? `PART-${index + 1}` : `JOB-MAT-${index + 1}`,
      name: row.name,
      quantity: Math.max(0.01, toNumber(row.quantity)),
      unitPrice: toNumber(row.unitCost),
    }));
    const labourLines = job.labourEntries.map((row, index) => ({
      sku: `LABOUR-${index + 1}`,
      name: `Labour`,
      quantity: Math.max(0.01, toNumber(row.hours)),
      unitPrice: toNumber(row.rate),
    }));
    const lines = [...materialLines, ...labourLines];
    if (lines.length > 0) return lines;
    const amount = job.invoiceAmount != null ? toNumber(job.invoiceAmount) : 0;
    return [
      {
        sku: `JOB-${job.reference}`,
        name: `Job ${job.reference}`,
        quantity: 1,
        unitPrice: Math.max(0, amount),
      },
    ];
  }

  private toSale(row: {
    id: string;
    tenantId: string;
    reference: string;
    customerId: string | null;
    customer: { name: string; phone?: string | null } | null;
    jobId?: string | null;
    job?: { reference: string; vehicleLabel?: string | null } | null;
    total: { toString(): string };
    discountAmount: { toString(): string } | null;
    taxAmount: { toString(): string } | null;
    notes: string | null;
    originalSaleId?: string | null;
    originalSale?: { reference: string } | null;
    currency: string;
    status: string;
    paymentStatus: string | null;
    paymentMethod?: string | null;
    cleanerUserId?: string | null;
    cleanerName?: string | null;
    serviceStaffEmployeeId?: string | null;
    serviceStaffEmployee?: { name: string } | null;
    locationCode: string | null;
    shippingStatus: string | null;
    shippingAddress: string | null;
    trackingNumber: string | null;
    date: Date;
    createdByUserId: string | null;
    createdByName: string | null;
    createdAt: Date;
    updatedAt: Date;
    lines?: Array<unknown>;
    _count?: { lines: number };
    payments?: Array<{ amount: { toString(): string } | number }>;
  }): Sale {
    const total = toNumber(row.total);
    const paidFromRows =
      row.payments?.reduce((sum, payment) => sum + toNumber(payment.amount), 0) ??
      0;
    const totalPaid =
      paidFromRows > 0
        ? paidFromRows
        : row.paymentStatus === 'paid'
          ? total
          : 0;
    const sellDue = Math.max(0, total - totalPaid);

    return {
      id: row.id,
      tenantId: row.tenantId,
      reference: row.reference,
      customerId: row.customerId,
      customerName: row.customer?.name ?? 'Walk-in',
      customerPhone: row.customer?.phone ?? null,
      jobId: row.jobId ?? null,
      jobReference: row.job?.reference ?? null,
      total,
      discountAmount: row.discountAmount ? toNumber(row.discountAmount) : null,
      taxAmount: row.taxAmount ? toNumber(row.taxAmount) : null,
      notes: row.notes,
      originalSaleId: row.originalSaleId ?? null,
      originalSaleReference: row.originalSale?.reference ?? null,
      currency: row.currency,
      status: mapSaleStatusToUi(row.status),
      recordStatus: row.status as Sale['recordStatus'],
      paymentStatus: row.paymentStatus as PaymentStatus | null,
      paymentMethod: row.paymentMethod ?? null,
      totalPaid,
      sellDue,
      cleanerUserId: row.cleanerUserId ?? null,
      cleanerName: row.cleanerName ?? null,
      serviceStaffEmployeeId: row.serviceStaffEmployeeId ?? null,
      serviceStaffEmployeeName: row.serviceStaffEmployee?.name ?? null,
      locationCode: row.locationCode,
      shippingStatus: row.shippingStatus as Sale['shippingStatus'],
      shippingAddress: row.shippingAddress,
      trackingNumber: row.trackingNumber,
      itemCount: row._count?.lines ?? row.lines?.length ?? 0,
      date: toIso(row.date).slice(0, 10),
      createdByUserId: row.createdByUserId,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  private toSaleDetail(row: {
    id: string;
    tenantId: string;
    reference: string;
    customerId: string | null;
    customer: {
      name: string;
      email?: string | null;
      phone?: string | null;
      totalSellDue?: { toString(): string } | number | null;
    } | null;
    jobId?: string | null;
    job?: { reference: string; vehicleLabel?: string | null } | null;
    total: { toString(): string };
    discountAmount: { toString(): string } | null;
    taxAmount: { toString(): string } | null;
    notes: string | null;
    originalSaleId?: string | null;
    originalSale?: { reference: string } | null;
    currency: string;
    status: string;
    paymentStatus: string | null;
    paymentMethod?: string | null;
    cleanerUserId?: string | null;
    cleanerName?: string | null;
    serviceStaffEmployeeId?: string | null;
    serviceStaffEmployee?: { name: string } | null;
    locationCode: string | null;
    shippingStatus: string | null;
    shippingAddress: string | null;
    trackingNumber: string | null;
    date: Date;
    createdByUserId: string | null;
    createdByName: string | null;
    createdAt: Date;
    updatedAt: Date;
    payments?: Array<{ amount: { toString(): string } | number }>;
    lines: Array<{
      id: string;
      saleId: string;
      itemId: string | null;
      sku: string;
      name: string;
      quantity: { toString(): string };
      unitPrice: { toString(): string };
      lineTotal: { toString(): string };
      discountAmount: { toString(): string } | null;
    }>;
  }): SaleDetail {
    const base = this.toSale(row);
    const lines: SaleLine[] = row.lines.map((line) => ({
      id: line.id,
      saleId: line.saleId,
      itemId: line.itemId,
      sku: line.sku,
      name: line.name,
      quantity: toNumber(line.quantity),
      unitPrice: toNumber(line.unitPrice),
      lineTotal: toNumber(line.lineTotal),
      discountAmount: line.discountAmount
        ? toNumber(line.discountAmount)
        : null,
    }));
    return {
      ...base,
      lines,
      customerEmail: row.customer?.email ?? null,
      customerPhone: row.customer?.phone ?? null,
      customerBusinessName: null,
      customerTotalSellDue:
        row.customer?.totalSellDue != null
          ? toNumber(row.customer.totalSellDue)
          : null,
      vehicleLabel: row.job?.vehicleLabel ?? null,
    };
  }
}

/** Boot/cron: seed default first-page sales list caches. */
export async function warmDefaultSalesListPages(
  prisma: import('@prisma/client').PrismaClient,
  cache: CacheService,
  tenantId: string,
): Promise<void> {
  for (const limit of [10, 25] as const) {
    for (const includeSummary of [false, true] as const) {
      const filterKey = listPageFilterKey({
        search: undefined,
        from: undefined,
        to: undefined,
        locationCode: undefined,
        customerId: undefined,
        jobId: undefined,
        paymentStatus: undefined,
        paymentMethod: undefined,
        cleanerUserId: undefined,
        serviceStaffEmployeeId: undefined,
        createdByUserId: undefined,
        status: undefined,
        saleStatus: undefined,
        returnsOnly: 0,
        shipmentsOnly: 0,
        cursor: undefined,
        limit,
        sortBy: undefined,
        sortDir: undefined,
        sum: includeSummary ? 1 : 0,
      });
      await withListPageCache(
        cache,
        tenantId,
        'sales',
        filterKey,
        async () => {
          const baseWhere = { tenantId, deletedAt: null };
          const [rows, totalCount, saleAmountAgg] = await Promise.all([
            prisma.sale.findMany({
              where: baseWhere,
              select: {
                id: true,
                tenantId: true,
                reference: true,
                customerId: true,
                customer: { select: { name: true, phone: true } },
                jobId: true,
                job: { select: { reference: true } },
                total: true,
                discountAmount: true,
                taxAmount: true,
                notes: true,
                originalSaleId: true,
                currency: true,
                status: true,
                paymentStatus: true,
                paymentMethod: true,
                cleanerUserId: true,
                cleanerName: true,
                serviceStaffEmployeeId: true,
                serviceStaffEmployee: { select: { name: true } },
                locationCode: true,
                shippingStatus: true,
                shippingAddress: true,
                trackingNumber: true,
                date: true,
                createdByUserId: true,
                createdByName: true,
                createdAt: true,
                updatedAt: true,
              },
              orderBy: [{ date: 'desc' }, { id: 'desc' }],
              take: limit,
            }),
            includeSummary
              ? prisma.sale.count({ where: baseWhere })
              : Promise.resolve(undefined as number | undefined),
            includeSummary
              ? prisma.sale.aggregate({
                  where: baseWhere,
                  _sum: { total: true },
                })
              : Promise.resolve(undefined),
          ]);
          const items = rows.map((row) => {
            const total = toNumber(row.total);
            const totalPaid = row.paymentStatus === 'paid' ? total : 0;
            const sellDue = Math.max(0, total - totalPaid);
            return {
              id: row.id,
              tenantId: row.tenantId,
              reference: row.reference,
              customerId: row.customerId,
              customerName: row.customer?.name ?? 'Walk-in',
              customerPhone: row.customer?.phone ?? null,
              jobId: row.jobId ?? null,
              jobReference: row.job?.reference ?? null,
              total,
              discountAmount: row.discountAmount
                ? toNumber(row.discountAmount)
                : null,
              taxAmount: row.taxAmount ? toNumber(row.taxAmount) : null,
              notes: row.notes,
              originalSaleId: row.originalSaleId ?? null,
              originalSaleReference: null,
              currency: row.currency,
              status: mapSaleStatusToUi(row.status),
              recordStatus: row.status,
              paymentStatus: row.paymentStatus,
              paymentMethod: row.paymentMethod ?? null,
              totalPaid,
              sellDue,
              cleanerUserId: row.cleanerUserId ?? null,
              cleanerName: row.cleanerName ?? null,
              serviceStaffEmployeeId: row.serviceStaffEmployeeId ?? null,
              serviceStaffEmployeeName: row.serviceStaffEmployee?.name ?? null,
              locationCode: row.locationCode,
              shippingStatus: row.shippingStatus,
              shippingAddress: row.shippingAddress,
              trackingNumber: row.trackingNumber,
              itemCount: 0,
              date: toIso(row.date).slice(0, 10),
              createdByUserId: row.createdByUserId,
              createdByName: row.createdByName,
              createdAt: toIso(row.createdAt),
              updatedAt: toIso(row.updatedAt),
            };
          });
          if (!includeSummary || totalCount == null || saleAmountAgg == null) {
            return { items };
          }
          return {
            items,
            totalCount,
            amountSummary: {
              totalAmount: toNumber(saleAmountAgg._sum.total),
              currency: 'NGN',
            },
          };
        },
      );
    }
  }
}
