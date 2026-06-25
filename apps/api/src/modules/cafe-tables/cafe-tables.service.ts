import { Injectable, NotFoundException } from '@nestjs/common';
import type { CafeTable, CafeTableStatus } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { toIso } from '../../common/utils/serializers';

function serialize(row: {
  id: string;
  tenantId: string;
  label: string;
  status: string;
  capacity: number;
  createdAt: Date;
  updatedAt: Date;
}): CafeTable {
  return {
    id: row.id,
    tenantId: row.tenantId,
    label: row.label,
    status: row.status as CafeTableStatus,
    capacity: row.capacity,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

@Injectable()
export class CafeTablesService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly auditService: AuditService,
  ) {}

  async list(): Promise<CafeTable[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.cafeTable.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { label: 'asc' },
    });
    return rows.map(serialize);
  }

  async getById(id: string): Promise<CafeTable> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.cafeTable.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Table not found');
    return serialize(row);
  }

  async create(body: {
    label: string;
    capacity?: number;
    status?: CafeTableStatus;
  }): Promise<CafeTable> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.cafeTable.create({
      data: {
        tenantId,
        label: body.label,
        capacity: body.capacity ?? 4,
        status: body.status ?? 'available',
      },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'cafeTable',
      entityId: row.id,
      summary: `Added table ${row.label}`,
    });
    return serialize(row);
  }

  async updateStatus(id: string, status: CafeTableStatus): Promise<CafeTable> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.cafeTable.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Table not found');

    const row = await this.tenantDb.db.cafeTable.update({
      where: { id },
      data: { status },
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'cafeTable',
      entityId: id,
      summary: `Table ${row.label} → ${status}`,
    });
    return serialize(row);
  }
}
