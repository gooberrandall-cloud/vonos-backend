import { Injectable, NotFoundException } from '@nestjs/common';
import type { SalonService } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { toIso, toNumber } from '../../common/utils/serializers';

function serialize(row: {
  id: string;
  tenantId: string;
  name: string;
  durationMinutes: number;
  price: { toString(): string };
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}): SalonService {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    durationMinutes: row.durationMinutes,
    price: toNumber(row.price),
    currency: row.currency,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

@Injectable()
export class SalonServicesService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly auditService: AuditService,
  ) {}

  async list(): Promise<SalonService[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.salonService.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return rows.map(serialize);
  }

  async getById(id: string): Promise<SalonService> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.salonService.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Service not found');
    return serialize(row);
  }

  async create(body: {
    name: string;
    durationMinutes?: number;
    price: number;
    currency?: string;
  }): Promise<SalonService> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.salonService.create({
      data: {
        tenantId,
        name: body.name,
        durationMinutes: body.durationMinutes ?? 60,
        price: body.price,
        currency: body.currency ?? 'NGN',
      },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'salonService',
      entityId: row.id,
      summary: `Added service ${row.name}`,
    });
    return serialize(row);
  }
}
