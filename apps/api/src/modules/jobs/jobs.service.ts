import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Job, JobLabour, JobMaterial } from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { getNextStage } from '../../common/utils/jobStages';
import { buildCursorQuery } from '../../common/utils/pagination';
import { toIso, toNumber } from '../../common/utils/serializers';

export interface JobDetail extends Job {
  materials: JobMaterial[];
  labourEntries: JobLabour[];
}

@Injectable()
export class JobsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(filters: {
    status?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Job[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.job.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.status ? { status: filters.status } : {}),
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
      },
      orderBy: { createdAt: 'desc' },
      ...buildCursorQuery(filters.cursor, filters.limit ?? 50),
    });
    return rows.map((row) => this.serializeJob(row));
  }

  async getById(id: string): Promise<JobDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { materials: true, labourEntries: true },
    });
    if (!row) throw new NotFoundException('Job not found');
    return {
      ...this.serializeJob(row),
      materials: row.materials.map((m) => ({
        id: m.id,
        jobId: m.jobId,
        itemId: m.itemId,
        name: m.name,
        quantity: toNumber(m.quantity),
        unitCost: toNumber(m.unitCost),
        totalCost: toNumber(m.totalCost),
        source: m.source,
      })),
      labourEntries: await this.resolveLabourWithStaffNames(row.labourEntries),
    };
  }

  async create(body: {
    reference: string;
    description: string;
    customerName?: string;
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
    const row = await this.tenantDb.db.job.create({
      data: {
        tenantId,
        reference: body.reference,
        description: body.description,
        status: 'Received',
        hasQuote: body.hasQuote ?? false,
        quoteAmount: body.quoteAmount ?? null,
        customerName: body.customerName ?? null,
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

  async advanceStatus(id: string): Promise<Job> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.job.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Job not found');

    const next = getNextStage(existing.status, existing.hasQuote);
    if (!next) {
      throw new BadRequestException('Job is already at the final stage');
    }

    const row = await this.tenantDb.db.job.update({
      where: { id },
      data: { status: next },
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'job',
      entityId: id,
      summary: `Status → ${next}`,
      metadata: { previousStatus: existing.status, status: next },
    });
    return this.serializeJob(row);
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

  private serializeJob(row: {
    id: string;
    tenantId: string;
    reference: string;
    description: string;
    status: string;
    hasQuote: boolean;
    quoteAmount: { toString(): string } | null;
    customerName: string | null;
    vehicleId: string | null;
    locationCode: string | null;
    assignedStaffIds: string[];
    dueDate: Date | null;
    createdByUserId: string | null;
    createdByName: string | null;
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
      customerName: row.customerName,
      vehicleId: row.vehicleId,
      locationCode: row.locationCode,
      assignedStaffIds: row.assignedStaffIds,
      dueDate: row.dueDate ? toIso(row.dueDate).slice(0, 10) : null,
      createdByUserId: row.createdByUserId,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }
}
