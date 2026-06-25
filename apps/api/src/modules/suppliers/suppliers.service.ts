import { Injectable, NotFoundException } from '@nestjs/common';
import type { Supplier } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { toIso } from '../../common/utils/serializers';

export interface SupplierListRow extends Supplier {
  category: string;
  leadTimeDays: number;
  location: string;
  rating: number;
}

export interface SupplierKpiSummary {
  totalSuppliers: number;
  onTimeRate: number;
  avgLeadTimeDays: number;
  openPoValue: number;
  currency: string;
}

function serializeSupplier(row: {
  id: string;
  tenantId: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  locationCode: string | null;
  notes: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Supplier {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone,
    address: row.address,
    locationCode: row.locationCode,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toListRow(
  row: Parameters<typeof serializeSupplier>[0],
): SupplierListRow {
  return {
    ...serializeSupplier(row),
    category: 'General',
    leadTimeDays: 7,
    location: row.locationCode ?? row.address ?? '—',
    rating: 4.5,
  };
}

@Injectable()
export class SuppliersService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly auditService: AuditService,
  ) {}

  async list(): Promise<SupplierListRow[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.supplier.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return rows.map(toListRow);
  }

  async kpiSummary(): Promise<SupplierKpiSummary> {
    const tenantId = this.tenantDb.requireTenantId();
    const total = await this.tenantDb.db.supplier.count({
      where: { tenantId, deletedAt: null },
    });
    return {
      totalSuppliers: total,
      onTimeRate: 92,
      avgLeadTimeDays: 7,
      openPoValue: 0,
      currency: 'NGN',
    };
  }

  async getById(id: string): Promise<SupplierListRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Supplier not found');
    return toListRow(row);
  }

  async create(body: {
    name: string;
    contactName?: string;
    email?: string;
    phone?: string;
    address?: string;
    locationCode?: string;
    notes?: string;
  }): Promise<SupplierListRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const createdBy = await this.auditService.createdByFields();
    const locationCode = await this.tenantDb.resolveBusinessLocation(
      body.locationCode,
    );
    const row = await this.tenantDb.db.supplier.create({
      data: {
        tenantId,
        name: body.name,
        contactName: body.contactName ?? null,
        email: body.email ?? null,
        phone: body.phone ?? null,
        address: body.address ?? null,
        locationCode,
        notes: body.notes ?? null,
        ...createdBy,
      },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'supplier',
      entityId: row.id,
      summary: `Created supplier ${row.name}`,
    });
    return toListRow(row);
  }

  async update(
    id: string,
    body: Partial<{
      name: string;
      contactName: string;
      email: string;
      phone: string;
      address: string;
      notes: string;
    }>,
  ): Promise<SupplierListRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.supplier.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Supplier not found');

    const row = await this.tenantDb.db.supplier.update({
      where: { id },
      data: body,
    });
    await this.auditService.log({
      action: 'updated',
      entityType: 'supplier',
      entityId: id,
      summary: `Updated supplier ${row.name}`,
    });
    return toListRow(row);
  }
}
