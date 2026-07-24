import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Job, JobLabour, JobMaterial } from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { InvoiceHubService } from '../invoices/invoice-hub.service';
import {
  assertCanAdvance,
  coerceJobStatus,
} from '../../common/utils/jobStages';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { toIso, toNumber } from '../../common/utils/serializers';
import { computeStockStatus, movementLineRollups } from '../../common/utils/stockQuantity';

export interface JobDetail extends Job {
  customer?: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    totalSellDue?: number | null;
  } | null;
  vehicle?: {
    id: string;
    plateNumber: string;
    make: string;
    model: string;
    year: number | null;
  } | null;
  materials: JobMaterial[];
  labourEntries: JobLabour[];
}

@Injectable()
export class JobsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly invoiceHub: InvoiceHubService,
  ) {}

  async list(filters: {
    status?: string;
    statuses?: string[];
    search?: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Job[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'createdAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const statusIn =
      filters.statuses && filters.statuses.length > 0
        ? filters.statuses
        : filters.status
          ? [filters.status]
          : undefined;
    const rows = await this.tenantDb.db.job.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(statusIn ? { status: { in: statusIn } } : {}),
        ...(filters.from || filters.to
          ? {
              createdAt: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
        ...(filters.search
          ? {
              OR: [
                {
                  reference: { contains: filters.search, mode: 'insensitive' },
                },
                {
                  description: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
                {
                  customerName: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
      select: {
        id: true,
        tenantId: true,
        reference: true,
        description: true,
        status: true,
        hasQuote: true,
        quoteAmount: true,
        customerName: true,
        customerId: true,
        vehicleId: true,
        dueDate: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map((row) => this.serializeJobList(row));
  }

  async getById(id: string): Promise<JobDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        materials: true,
        labourEntries: true,
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            totalSellDue: true,
          },
        },
        sales: {
          where: { deletedAt: null },
          select: { id: true },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!row) throw new NotFoundException('Job not found');
    const itemIds = [
      ...new Set(
        row.materials
          .map((m) => m.itemId)
          .filter((mid): mid is string => Boolean(mid)),
      ),
    ];
    const [vehicle, catalogItems] = await Promise.all([
      row.vehicleId
        ? this.tenantDb.db.vehicle.findFirst({
            where: { id: row.vehicleId, tenantId, deletedAt: null },
            select: {
              id: true,
              plateNumber: true,
              make: true,
              model: true,
              year: true,
            },
          })
        : Promise.resolve(null),
      itemIds.length > 0
        ? this.tenantDb.db.item.findMany({
            where: { id: { in: itemIds }, deletedAt: null },
            select: { id: true, sku: true },
          })
        : Promise.resolve([] as Array<{ id: string; sku: string }>),
    ]);
    const skuByItemId = new Map(catalogItems.map((item) => [item.id, item.sku]));
    return {
      ...this.serializeJob(row),
      saleId: row.sales[0]?.id ?? null,
      customer: row.customer
        ? {
            id: row.customer.id,
            name: row.customer.name,
            email: row.customer.email,
            phone: row.customer.phone,
            totalSellDue:
              row.customer.totalSellDue != null
                ? toNumber(row.customer.totalSellDue)
                : null,
          }
        : null,
      vehicle: vehicle
        ? {
            id: vehicle.id,
            plateNumber: vehicle.plateNumber,
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
          }
        : null,
      materials: row.materials.map((m) => ({
        id: m.id,
        jobId: m.jobId,
        itemId: m.itemId,
        name: m.name,
        quantity: toNumber(m.quantity),
        unitCost: toNumber(m.unitCost),
        totalCost: toNumber(m.totalCost),
        sku: m.itemId ? (skuByItemId.get(m.itemId) ?? null) : null,
        source: m.source,
        sourceType: (m.sourceType as JobMaterial['sourceType']) ?? null,
        sourceDepartment: m.sourceDepartment,
        supplierId: m.supplierId,
        supplierName: m.supplierName,
        purchaseMovementId: m.purchaseMovementId,
      })),
      labourEntries: await this.resolveLabourWithStaffNames(row.labourEntries),
    };
  }

  /** Job header + customer/vehicle — no materials/labour (fast first paint). */
  async getShell(id: string): Promise<JobDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            totalSellDue: true,
          },
        },
        sales: {
          where: { deletedAt: null },
          select: { id: true },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!row) throw new NotFoundException('Job not found');
    const vehicle = row.vehicleId
      ? await this.tenantDb.db.vehicle.findFirst({
          where: { id: row.vehicleId, tenantId, deletedAt: null },
          select: {
            id: true,
            plateNumber: true,
            make: true,
            model: true,
            year: true,
          },
        })
      : null;
    return {
      ...this.serializeJob(row),
      saleId: row.sales[0]?.id ?? null,
      customer: row.customer
        ? {
            id: row.customer.id,
            name: row.customer.name,
            email: row.customer.email,
            phone: row.customer.phone,
            totalSellDue:
              row.customer.totalSellDue != null
                ? toNumber(row.customer.totalSellDue)
                : null,
          }
        : null,
      vehicle: vehicle
        ? {
            id: vehicle.id,
            plateNumber: vehicle.plateNumber,
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
          }
        : null,
      materials: [],
      labourEntries: [],
    };
  }

  /** Materials + labour for a job (loaded after shell). */
  async getCosts(id: string): Promise<{
    materials: JobMaterial[];
    labourEntries: JobLabour[];
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        id: true,
        materials: true,
        labourEntries: true,
      },
    });
    if (!row) throw new NotFoundException('Job not found');
    const itemIds = [
      ...new Set(
        row.materials
          .map((m) => m.itemId)
          .filter((mid): mid is string => Boolean(mid)),
      ),
    ];
    const catalogItems =
      itemIds.length > 0
        ? await this.tenantDb.db.item.findMany({
            where: { id: { in: itemIds }, deletedAt: null },
            select: { id: true, sku: true },
          })
        : [];
    const skuByItemId = new Map(catalogItems.map((item) => [item.id, item.sku]));
    return {
      materials: row.materials.map((m) => ({
        id: m.id,
        jobId: m.jobId,
        itemId: m.itemId,
        name: m.name,
        quantity: toNumber(m.quantity),
        unitCost: toNumber(m.unitCost),
        totalCost: toNumber(m.totalCost),
        sku: m.itemId ? (skuByItemId.get(m.itemId) ?? null) : null,
        source: m.source,
        sourceType: (m.sourceType as JobMaterial['sourceType']) ?? null,
        sourceDepartment: m.sourceDepartment,
        supplierId: m.supplierId,
        supplierName: m.supplierName,
        purchaseMovementId: m.purchaseMovementId,
      })),
      labourEntries: await this.resolveLabourWithStaffNames(row.labourEntries),
    };
  }

  async getMeta(id: string): Promise<{ id: string; reference: string }> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, reference: true },
    });
    if (!row) throw new NotFoundException('Job not found');
    return row;
  }

  async create(body: {
    reference: string;
    description: string;
    customerName?: string;
    customerId?: string;
    vehicleId?: string;
    locationCode?: string;
    hasQuote?: boolean;
    quoteAmount?: number;
    dueDate?: string;
  }): Promise<Job> {
    const tenantId = this.tenantDb.requireTenantId();
    const createdBy = await this.auditService.createdByFields();
    const locationCode = await this.tenantDb.resolveBusinessLocation(
      body.locationCode,
    );
    let customerName = body.customerName ?? null;
    let customerId = body.customerId ?? null;
    if (customerId) {
      const customer = await this.tenantDb.db.customer.findFirst({
        where: { id: customerId, tenantId, deletedAt: null },
        select: { name: true },
      });
      if (!customer) {
        throw new BadRequestException('Customer not found');
      }
      customerName = customer.name;
    }
    const row = await this.tenantDb.db.job.create({
      data: {
        tenantId,
        reference: body.reference,
        description: body.description,
        status: 'Received',
        hasQuote: body.hasQuote ?? false,
        quoteAmount: body.quoteAmount ?? null,
        customerId,
        customerName,
        vehicleId: body.vehicleId ?? null,
        locationCode,
        assignedStaffIds: [],
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        ...createdBy,
      },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'job',
      entityId: row.id,
      summary: `Created job ${row.reference}`,
    });
    return this.serializeJob(row);
  }

  /** Link (or unlink with null) a vehicle to a job. */
  async setVehicle(jobId: string, vehicleId: string | null): Promise<JobDetail> {
    const job = await this.requireJob(jobId);
    const tenantId = this.tenantDb.requireTenantId();

    let summary: string;
    if (vehicleId) {
      const vehicle = await this.tenantDb.db.vehicle.findFirst({
        where: { id: vehicleId, tenantId, deletedAt: null },
        select: { id: true, plateNumber: true },
      });
      if (!vehicle) {
        throw new BadRequestException('Vehicle not found');
      }
      summary = `Linked vehicle ${vehicle.plateNumber} to ${job.reference}`;
    } else {
      summary = `Unlinked vehicle from ${job.reference}`;
    }

    await this.tenantDb.db.job.update({
      where: { id: job.id },
      data: { vehicleId },
    });

    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: jobId,
      summary,
      metadata: { vehicleId },
    });

    return this.getById(jobId);
  }

  async advanceStatus(id: string): Promise<Job> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Job not found');

    const qcChecklist =
      existing.qcChecklist &&
      typeof existing.qcChecklist === 'object' &&
      !Array.isArray(existing.qcChecklist)
        ? (existing.qcChecklist as Record<string, boolean>)
        : null;

    let next;
    try {
      next = assertCanAdvance({
        currentStatus: existing.status,
        hasQuote: existing.hasQuote,
        quoteAmount: existing.quoteAmount
          ? toNumber(existing.quoteAmount)
          : null,
        qcChecklist,
      });
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Cannot advance job status',
      );
    }

    const coerced = coerceJobStatus(existing.status, existing.hasQuote);
    const row = await this.tenantDb.db.job.update({
      where: { id },
      data: { status: next },
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: id,
      summary: `Status → ${next}`,
      metadata: {
        previousStatus: existing.status,
        coercedFrom: coerced !== existing.status ? coerced : undefined,
        status: next,
      },
    });
    return this.serializeJob(row);
  }

  async updateBilling(
    id: string,
    body: {
      hasQuote?: boolean;
      quoteAmount?: number | null;
      quoteNotes?: string | null;
      quoteValidUntil?: string | null;
      invoiceAmount?: number | null;
      invoiceNotes?: string | null;
    },
  ): Promise<JobDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Job not found');

    const hasQuote =
      body.hasQuote ??
      (body.quoteAmount != null ? true : existing.hasQuote);

    await this.tenantDb.db.job.update({
      where: { id },
      data: {
        hasQuote,
        ...(body.quoteAmount !== undefined
          ? { quoteAmount: body.quoteAmount }
          : {}),
        ...(body.quoteNotes !== undefined
          ? { quoteNotes: body.quoteNotes }
          : {}),
        ...(body.quoteValidUntil !== undefined
          ? {
              quoteValidUntil: body.quoteValidUntil
                ? new Date(body.quoteValidUntil)
                : null,
            }
          : {}),
        ...(body.invoiceAmount !== undefined
          ? { invoiceAmount: body.invoiceAmount }
          : {}),
        ...(body.invoiceNotes !== undefined
          ? { invoiceNotes: body.invoiceNotes }
          : {}),
      },
    });

    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: id,
      summary: `Updated quote/invoice draft for ${existing.reference}`,
    });

    const updated = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (updated) {
      if (updated.hasQuote || updated.quoteAmount != null) {
        await this.invoiceHub.ensureJobDocumentInvoice(
          this.tenantDb.db,
          updated,
          'job_quote',
        );
      }
      if (updated.invoiceAmount != null) {
        await this.invoiceHub.ensureJobDocumentInvoice(
          this.tenantDb.db,
          updated,
          'job_invoice',
        );
      }
    }

    return this.getById(id);
  }

  async updateQc(
    id: string,
    body: {
      qcChecklist?: Record<string, boolean> | null;
      qcNotes?: string | null;
    },
  ): Promise<JobDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Job not found');

    await this.tenantDb.db.job.update({
      where: { id },
      data: {
        ...(body.qcChecklist !== undefined
          ? {
              qcChecklist:
                body.qcChecklist === null
                  ? Prisma.JsonNull
                  : body.qcChecklist,
            }
          : {}),
        ...(body.qcNotes !== undefined ? { qcNotes: body.qcNotes } : {}),
      },
    });

    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: id,
      summary: `Updated QC checklist for ${existing.reference}`,
    });

    return this.getById(id);
  }

  async addMaterial(
    jobId: string,
    body: {
      itemId?: string;
      name: string;
      quantity: number;
      unitCost: number;
      source?: string;
      sourceType?: JobMaterial['sourceType'];
      sourceDepartment?: string;
      supplierId?: string;
    },
  ): Promise<JobDetail> {
    const job = await this.requireJob(jobId);
    const tenantId = this.tenantDb.requireTenantId();
    const quantity = body.quantity;
    const unitCost = body.unitCost;
    const name = body.name?.trim();
    if (!name) {
      throw new BadRequestException('Material name is required');
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than zero');
    }
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new BadRequestException('Invalid unit cost');
    }

    const sourceType = body.sourceType ?? 'shop';
    let resolvedSourceType: JobMaterial['sourceType'] = sourceType;
    let sourceDepartment: string | null = null;
    let supplierId: string | null = null;
    let supplierName: string | null = null;
    let purchaseMovementId: string | null = null;
    let resolvedItemId: string | null = body.itemId ?? null;

    if (sourceType === 'internal') {
      const code = body.sourceDepartment?.trim();
      if (!code) {
        throw new BadRequestException(
          'Select the department supplying this part',
        );
      }
      const department = await this.prisma.tenant.findFirst({
        where: { code, deletedAt: null },
        select: { code: true },
      });
      if (!department) {
        throw new BadRequestException(`Unknown department "${code}"`);
      }
      sourceDepartment = department.code;
    } else if (sourceType === 'external') {
      if (!body.supplierId) {
        throw new BadRequestException(
          'Select a supplier for the external purchase',
        );
      }
      const supplier = await this.tenantDb.db.supplier.findFirst({
        where: { id: body.supplierId, tenantId, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!supplier) {
        throw new BadRequestException('Supplier not found');
      }
      supplierId = supplier.id;
      supplierName = supplier.name;
    }

    const totalCost = quantity * unitCost;

    if (sourceType === 'shop') {
      const stocked = await this.resolveShopStockForMaterial({
        tenantId,
        itemId: body.itemId,
        name,
        quantity,
        unitCost,
        jobReference: job.reference,
      });
      resolvedSourceType = stocked.sourceType;
      sourceDepartment = stocked.sourceDepartment;
      supplierId = stocked.supplierId;
      supplierName = stocked.supplierName;
      purchaseMovementId = stocked.purchaseMovementId;
      resolvedItemId = stocked.itemId;
    } else if (sourceType === 'external' && supplierId) {
      // Explicit external purchase — inbound movement for Purchases list.
      const suffix = Date.now().toString(36).slice(-4).toUpperCase();
      const purchaseLines = [
        {
          itemId: body.itemId ?? null,
          name,
          quantity,
          unitCost,
          total: totalCost,
        },
      ];
      const purchaseRollups = movementLineRollups(purchaseLines);
      const purchase = await this.tenantDb.db.stockMovement.create({
        data: {
          tenantId,
          type: 'inbound',
          reference: `${job.reference}-P${suffix}`,
          status: 'Received',
          supplierId,
          lines: purchaseLines as unknown as Prisma.InputJsonValue,
          itemCount: purchaseRollups.itemCount,
          grandTotal: purchaseRollups.grandTotal,
          notes: `External purchase for job ${job.reference} | ${supplierName}`,
          date: new Date(),
        },
      });
      purchaseMovementId = purchase.id;
    }

    await this.tenantDb.db.jobMaterial.create({
      data: {
        jobId: job.id,
        itemId: resolvedItemId,
        name,
        quantity,
        unitCost,
        totalCost,
        source: body.source?.trim() || null,
        sourceType: resolvedSourceType,
        sourceDepartment,
        supplierId,
        supplierName,
        purchaseMovementId,
      },
    });

    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: jobId,
      summary: `Added material ${name} to ${job.reference}`,
      metadata: {
        quantity,
        unitCost,
        totalCost,
        sourceType: resolvedSourceType,
        sourceDepartment,
        supplierId,
        purchaseMovementId,
      },
    });

    return this.getById(jobId);
  }

  async updateMaterial(
    jobId: string,
    materialId: string,
    body: {
      name?: string;
      quantity?: number;
      unitCost?: number;
      source?: string | null;
    },
  ): Promise<JobDetail> {
    const job = await this.requireJob(jobId);
    const existing = await this.tenantDb.db.jobMaterial.findFirst({
      where: { id: materialId, jobId: job.id },
    });
    if (!existing) throw new NotFoundException('Material not found');

    const quantity =
      body.quantity !== undefined ? body.quantity : toNumber(existing.quantity);
    const unitCost =
      body.unitCost !== undefined ? body.unitCost : toNumber(existing.unitCost);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than zero');
    }
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new BadRequestException('Invalid unit cost');
    }

    await this.tenantDb.db.jobMaterial.update({
      where: { id: materialId },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        quantity,
        unitCost,
        totalCost: quantity * unitCost,
        ...(body.source !== undefined ? { source: body.source } : {}),
      },
    });

    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: jobId,
      summary: `Updated material on ${job.reference}`,
      metadata: { materialId },
    });

    return this.getById(jobId);
  }

  async removeMaterial(jobId: string, materialId: string): Promise<JobDetail> {
    const job = await this.requireJob(jobId);
    const existing = await this.tenantDb.db.jobMaterial.findFirst({
      where: { id: materialId, jobId: job.id },
    });
    if (!existing) throw new NotFoundException('Material not found');

    // Void the linked external purchase so Purchases stays consistent.
    if (existing.purchaseMovementId) {
      await this.tenantDb.db.stockMovement.updateMany({
        where: { id: existing.purchaseMovementId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    await this.tenantDb.db.jobMaterial.delete({ where: { id: materialId } });

    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: jobId,
      summary: `Removed material ${existing.name} from ${job.reference}`,
      metadata: { materialId, purchaseMovementId: existing.purchaseMovementId },
    });

    return this.getById(jobId);
  }

  async addLabour(
    jobId: string,
    body: { staffId: string; hours: number; rate: number },
  ): Promise<JobDetail> {
    const job = await this.requireJob(jobId);
    const hours = body.hours;
    const rate = body.rate;
    if (!body.staffId?.trim()) {
      throw new BadRequestException('Staff is required');
    }
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new BadRequestException('Hours must be greater than zero');
    }
    if (!Number.isFinite(rate) || rate < 0) {
      throw new BadRequestException('Invalid rate');
    }

    const staff = await this.prisma.user.findFirst({
      where: {
        id: body.staffId,
        tenantId: job.tenantId,
        status: 'active',
      },
      select: { id: true },
    });
    if (!staff) throw new BadRequestException('Staff member not found');

    const totalCost = hours * rate;
    await this.tenantDb.db.jobLabour.create({
      data: {
        jobId: job.id,
        staffId: body.staffId,
        hours,
        rate,
        totalCost,
      },
    });

    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: jobId,
      summary: `Added labour entry to ${job.reference}`,
      metadata: { staffId: body.staffId, hours, rate, totalCost },
    });

    return this.getById(jobId);
  }

  async updateLabour(
    jobId: string,
    labourId: string,
    body: { staffId?: string; hours?: number; rate?: number },
  ): Promise<JobDetail> {
    const job = await this.requireJob(jobId);
    const existing = await this.tenantDb.db.jobLabour.findFirst({
      where: { id: labourId, jobId: job.id },
    });
    if (!existing) throw new NotFoundException('Labour entry not found');

    const hours =
      body.hours !== undefined ? body.hours : toNumber(existing.hours);
    const rate = body.rate !== undefined ? body.rate : toNumber(existing.rate);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new BadRequestException('Hours must be greater than zero');
    }
    if (!Number.isFinite(rate) || rate < 0) {
      throw new BadRequestException('Invalid rate');
    }

    if (body.staffId) {
      const staff = await this.prisma.user.findFirst({
        where: {
          id: body.staffId,
          tenantId: job.tenantId,
          status: 'active',
        },
        select: { id: true },
      });
      if (!staff) throw new BadRequestException('Staff member not found');
    }

    await this.tenantDb.db.jobLabour.update({
      where: { id: labourId },
      data: {
        ...(body.staffId !== undefined ? { staffId: body.staffId } : {}),
        hours,
        rate,
        totalCost: hours * rate,
      },
    });

    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: jobId,
      summary: `Updated labour on ${job.reference}`,
      metadata: { labourId },
    });

    return this.getById(jobId);
  }

  async removeLabour(jobId: string, labourId: string): Promise<JobDetail> {
    const job = await this.requireJob(jobId);
    const existing = await this.tenantDb.db.jobLabour.findFirst({
      where: { id: labourId, jobId: job.id },
    });
    if (!existing) throw new NotFoundException('Labour entry not found');

    await this.tenantDb.db.jobLabour.delete({ where: { id: labourId } });

    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: jobId,
      summary: `Removed labour entry from ${job.reference}`,
      metadata: { labourId },
    });

    return this.getById(jobId);
  }

  /**
   * Own-stock path for VA (and any job tenant):
   * 1) Deduct from this tenant's catalog if enough on hand
   * 2) Else deduct from VW Warehouse if that SKU has stock
   * 3) Else create a normal inbound purchase (no supplier required)
   */
  private async resolveShopStockForMaterial(input: {
    tenantId: string;
    itemId?: string;
    name: string;
    quantity: number;
    unitCost: number;
    jobReference: string;
  }): Promise<{
    sourceType: JobMaterial['sourceType'];
    sourceDepartment: string | null;
    supplierId: string | null;
    supplierName: string | null;
    purchaseMovementId: string | null;
    itemId: string | null;
  }> {
    const totalCost = input.quantity * input.unitCost;

    const tryDeduct = async (
      item: {
        id: string;
        quantity: { toString(): string } | number | string | null;
        reorderPoint: number | null;
        tenantId: string;
      },
      asInternalFrom?: string,
    ) => {
      const currentQty = toNumber(item.quantity);
      if (currentQty < input.quantity) return null;
      const nextQuantity = currentQty - input.quantity;
      await this.prisma.item.update({
        where: { id: item.id },
        data: {
          quantity: nextQuantity,
          status: computeStockStatus(nextQuantity, item.reorderPoint),
        },
      });
      if (asInternalFrom) {
        return {
          sourceType: 'internal' as const,
          sourceDepartment: asInternalFrom,
          supplierId: null,
          supplierName: null,
          purchaseMovementId: null,
          itemId: item.id,
        };
      }
      return {
        sourceType: 'shop' as const,
        sourceDepartment: null,
        supplierId: null,
        supplierName: null,
        purchaseMovementId: null,
        itemId: item.id,
      };
    };

    let localItem =
      input.itemId != null
        ? await this.prisma.item.findFirst({
            where: {
              id: input.itemId,
              tenantId: input.tenantId,
              deletedAt: null,
            },
          })
        : null;

    if (!localItem && input.name) {
      localItem = await this.prisma.item.findFirst({
        where: {
          tenantId: input.tenantId,
          deletedAt: null,
          OR: [
            { name: { equals: input.name, mode: 'insensitive' } },
            { sku: { equals: input.name, mode: 'insensitive' } },
          ],
        },
      });
    }

    if (localItem) {
      const deducted = await tryDeduct(localItem);
      if (deducted) return deducted;
    }

    const sku = localItem?.sku ?? null;
    const vw = await this.prisma.tenant.findFirst({
      where: { code: 'VW', deletedAt: null },
      select: { id: true, code: true },
    });
    if (vw && (sku || input.name)) {
      const vwItem = await this.prisma.item.findFirst({
        where: {
          tenantId: vw.id,
          deletedAt: null,
          OR: [
            ...(sku
              ? [{ sku: { equals: sku, mode: 'insensitive' as const } }]
              : []),
            { name: { equals: input.name, mode: 'insensitive' } },
            ...(localItem?.name
              ? [
                  {
                    name: {
                      equals: localItem.name,
                      mode: 'insensitive' as const,
                    },
                  },
                ]
              : []),
          ],
        },
      });
      if (vwItem) {
        const deducted = await tryDeduct(vwItem, 'VW');
        if (deducted) return deducted;
      }
    }

    const suffix = Date.now().toString(36).slice(-4).toUpperCase();
    const purchaseLines = [
      {
        itemId: localItem?.id ?? input.itemId ?? null,
        sku: sku,
        name: input.name,
        quantity: input.quantity,
        unitCost: input.unitCost,
        total: totalCost,
      },
    ];
    const purchaseRollups = movementLineRollups(purchaseLines);
    const purchase = await this.tenantDb.db.stockMovement.create({
      data: {
        tenantId: input.tenantId,
        type: 'inbound',
        reference: `${input.jobReference}-P${suffix}`,
        status: 'Received',
        lines: purchaseLines as unknown as Prisma.InputJsonValue,
        itemCount: purchaseRollups.itemCount,
        grandTotal: purchaseRollups.grandTotal,
        notes: `Auto-purchase for job ${input.jobReference} — not enough stock in shop or VW`,
        date: new Date(),
      },
    });

    return {
      sourceType: 'external',
      sourceDepartment: null,
      supplierId: null,
      supplierName: 'Purchase (not in stock)',
      purchaseMovementId: purchase.id,
      itemId: localItem?.id ?? input.itemId ?? null,
    };
  }

  private async requireJob(id: string) {
    const tenantId = this.tenantDb.requireTenantId();
    const job = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  private async resolveLabourWithStaffNames(
    rows: Array<{
      id: string;
      jobId: string;
      staffId: string;
      hours: { toString(): string };
      rate: { toString(): string };
      totalCost: { toString(): string };
    }>,
  ): Promise<JobLabour[]> {
    if (rows.length === 0) return [];

    const staffIds = [...new Set(rows.map((row) => row.staffId))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((user) => [user.id, user.name]));

    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      staffId: row.staffId,
      staffName: nameById.get(row.staffId) ?? null,
      hours: toNumber(row.hours),
      rate: toNumber(row.rate),
      totalCost: toNumber(row.totalCost),
    }));
  }

  private serializeJobList(row: {
    id: string;
    tenantId: string;
    reference: string;
    description: string;
    status: string;
    hasQuote: boolean;
    quoteAmount: { toString(): string } | null;
    customerName: string | null;
    customerId: string | null;
    vehicleId: string | null;
    dueDate: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Job {
    return {
      id: row.id,
      tenantId: row.tenantId,
      reference: row.reference,
      description: row.description,
      status: row.status,
      hasQuote: row.hasQuote,
      quoteAmount: row.quoteAmount ? toNumber(row.quoteAmount) : null,
      quoteNotes: null,
      quoteValidUntil: null,
      invoiceAmount: null,
      invoiceNotes: null,
      customerId: row.customerId,
      customerName: row.customerName,
      vehicleId: row.vehicleId,
      locationCode: null,
      assignedStaffIds: [],
      dueDate: row.dueDate ? toIso(row.dueDate).slice(0, 10) : null,
      qcChecklist: null,
      qcNotes: null,
      createdByUserId: null,
      createdByName: null,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  private serializeJob(row: {
    id: string;
    tenantId: string;
    reference: string;
    description: string;
    status: string;
    hasQuote: boolean;
    quoteAmount: { toString(): string } | null;
    quoteNotes: string | null;
    quoteValidUntil: Date | null;
    invoiceAmount: { toString(): string } | null;
    invoiceNotes: string | null;
    customerName: string | null;
    customerId: string | null;
    vehicleId: string | null;
    locationCode: string | null;
    assignedStaffIds: string[];
    dueDate: Date | null;
    qcChecklist: unknown;
    qcNotes: string | null;
    createdByUserId: string | null;
    createdByName: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): Job {
    const qcChecklist =
      row.qcChecklist &&
      typeof row.qcChecklist === 'object' &&
      !Array.isArray(row.qcChecklist)
        ? (row.qcChecklist as Record<string, boolean>)
        : null;

    return {
      id: row.id,
      tenantId: row.tenantId,
      reference: row.reference,
      description: row.description,
      status: row.status,
      hasQuote: row.hasQuote,
      quoteAmount: row.quoteAmount ? toNumber(row.quoteAmount) : null,
      quoteNotes: row.quoteNotes ?? null,
      quoteValidUntil: row.quoteValidUntil
        ? toIso(row.quoteValidUntil).slice(0, 10)
        : null,
      invoiceAmount: row.invoiceAmount ? toNumber(row.invoiceAmount) : null,
      invoiceNotes: row.invoiceNotes ?? null,
      customerId: row.customerId,
      customerName: row.customerName,
      vehicleId: row.vehicleId,
      locationCode: row.locationCode,
      assignedStaffIds: row.assignedStaffIds,
      dueDate: row.dueDate ? toIso(row.dueDate).slice(0, 10) : null,
      qcChecklist,
      qcNotes: row.qcNotes,
      createdByUserId: row.createdByUserId,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }
}
