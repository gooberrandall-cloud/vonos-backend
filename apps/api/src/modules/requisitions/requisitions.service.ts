import { Injectable, NotFoundException } from '@nestjs/common';
import type { Requisition, RequisitionStatus } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { toIso } from '../../common/utils/serializers';

function serialize(row: {
  id: string;
  tenantId: string;
  reference: string;
  status: string;
  jobId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Requisition {
  return {
    id: row.id,
    tenantId: row.tenantId,
    reference: row.reference,
    status: row.status as RequisitionStatus,
    jobId: row.jobId,
    notes: row.notes,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

@Injectable()
export class RequisitionsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly auditService: AuditService,
  ) {}

  async list(): Promise<Requisition[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.requisition.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(serialize);
  }

  async getById(id: string): Promise<Requisition> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.requisition.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Requisition not found');
    return serialize(row);
  }

  async create(body: {
    reference: string;
    jobId?: string;
    notes?: string;
  }): Promise<Requisition> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.requisition.create({
      data: {
        tenantId,
        reference: body.reference,
        status: 'Pending',
        jobId: body.jobId ?? null,
        notes: body.notes ?? null,
      },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'requisition',
      entityId: row.id,
      summary: `Created requisition ${row.reference}`,
    });
    return serialize(row);
  }
}
