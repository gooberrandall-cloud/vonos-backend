import { Injectable, NotFoundException } from '@nestjs/common';
import type { Vehicle, VehicleJobHistoryEntry } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { toIso } from '../../common/utils/serializers';

function serialize(row: {
  id: string;
  tenantId: string;
  plateNumber: string;
  vin: string | null;
  make: string;
  model: string;
  year: number | null;
  ownerName: string;
  ownerPhone: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Vehicle {
  return {
    id: row.id,
    tenantId: row.tenantId,
    plateNumber: row.plateNumber,
    vin: row.vin,
    make: row.make,
    model: row.model,
    year: row.year,
    ownerName: row.ownerName,
    ownerPhone: row.ownerPhone,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

@Injectable()
export class VehiclesService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly auditService: AuditService,
  ) {}

  async list(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    make?: string;
  } = {}): Promise<Vehicle[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'plateNumber',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'string',
    });
    const rows = await this.tenantDb.db.vehicle.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? {
              OR: [
                {
                  plateNumber: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
                { make: { contains: filters.search, mode: 'insensitive' } },
                { model: { contains: filters.search, mode: 'insensitive' } },
                {
                  ownerName: { contains: filters.search, mode: 'insensitive' },
                },
              ],
            }
          : {}),
        ...(filters.make ? { make: filters.make } : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ plateNumber: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    return rows.map(serialize);
  }

  async getById(id: string): Promise<Vehicle> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.vehicle.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Vehicle not found');
    return serialize(row);
  }

  async getHistory(id: string): Promise<VehicleJobHistoryEntry[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const vehicle = await this.tenantDb.db.vehicle.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    const jobs = await this.tenantDb.db.job.findMany({
      where: { tenantId, vehicleId: id, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        id: true,
        reference: true,
        status: true,
        customerName: true,
        dueDate: true,
        quoteAmount: true,
        invoiceAmount: true,
      },
    });

    return jobs.map((row) => ({
      id: row.id,
      reference: row.reference,
      status: row.status,
      customerName: row.customerName,
      dueDate: row.dueDate ? toIso(row.dueDate).slice(0, 10) : null,
      quoteAmount: row.quoteAmount ? Number(row.quoteAmount) : null,
      invoiceAmount: row.invoiceAmount ? Number(row.invoiceAmount) : null,
    }));
  }

  async create(body: {
    plateNumber: string;
    vin?: string;
    make: string;
    model: string;
    year?: number;
    ownerName: string;
    ownerPhone?: string;
  }): Promise<Vehicle> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.vehicle.create({
      data: {
        tenantId,
        plateNumber: body.plateNumber,
        vin: body.vin ?? null,
        make: body.make,
        model: body.model,
        year: body.year ?? null,
        ownerName: body.ownerName,
        ownerPhone: body.ownerPhone ?? null,
      },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'vehicle',
      entityId: row.id,
      summary: `Registered vehicle ${row.plateNumber}`,
    });
    return serialize(row);
  }

  async update(
    id: string,
    body: {
      plateNumber?: string;
      vin?: string | null;
      make?: string;
      model?: string;
      year?: number | null;
      ownerName?: string;
      ownerPhone?: string | null;
    },
  ): Promise<Vehicle> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.vehicle.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Vehicle not found');

    const row = await this.tenantDb.db.vehicle.update({
      where: { id },
      data: {
        ...(body.plateNumber !== undefined
          ? { plateNumber: body.plateNumber }
          : {}),
        ...(body.vin !== undefined ? { vin: body.vin } : {}),
        ...(body.make !== undefined ? { make: body.make } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.year !== undefined ? { year: body.year } : {}),
        ...(body.ownerName !== undefined ? { ownerName: body.ownerName } : {}),
        ...(body.ownerPhone !== undefined ? { ownerPhone: body.ownerPhone } : {}),
      },
    });

    await this.auditService.log({
      action: 'updated',
      entityType: 'vehicle',
      entityId: row.id,
      summary: `Updated vehicle ${row.plateNumber}`,
    });

    return serialize(row);
  }
}
