import { Injectable, NotFoundException } from '@nestjs/common';
import type { Vehicle } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
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

  async list(): Promise<Vehicle[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.vehicle.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { plateNumber: 'asc' },
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
}
