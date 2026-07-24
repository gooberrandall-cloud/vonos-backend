import { Injectable, NotFoundException } from '@nestjs/common';
import type { AppointmentListRow } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { toIso, toNumber } from '../../common/utils/serializers';

function serializeAppointment(row: {
  id: string;
  tenantId: string;
  customerId: string | null;
  customer: { name: string } | null;
  stylistName: string;
  serviceName: string;
  servicePrice: { toString(): string };
  currency: string;
  startTime: Date;
  endTime: Date;
  status: string;
  notes: string | null;
  locationCode: string | null;
}): AppointmentListRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId,
    customerName: row.customer?.name ?? 'Walk-in',
    stylistName: row.stylistName,
    serviceName: row.serviceName,
    servicePrice: toNumber(row.servicePrice),
    currency: row.currency,
    startTime: toIso(row.startTime),
    endTime: toIso(row.endTime),
    status: row.status,
    notes: row.notes,
    locationCode: row.locationCode,
  };
}

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly auditService: AuditService,
  ) {}

  async list(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    from?: string;
    to?: string;
    status?: string;
  } = {}): Promise<AppointmentListRow[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'startTime',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.tenantDb.db.appointment.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.from || filters.to
          ? {
              startTime: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
        ...(filters.search
          ? {
              OR: [
                {
                  customer: {
                    name: { contains: filters.search, mode: 'insensitive' },
                  },
                },
                {
                  stylistName: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
                {
                  serviceName: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
        ...(pagination.where ?? {}),
      },
      include: { customer: { select: { name: true } } },
      orderBy: [{ startTime: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    return rows.map(serializeAppointment);
  }

  async getById(id: string): Promise<AppointmentListRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.appointment.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { customer: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Appointment not found');
    return serializeAppointment(row);
  }

  async create(body: {
    customerName?: string;
    stylistName: string;
    serviceName: string;
    servicePrice?: number;
    currency?: string;
    startTime: string;
    endTime: string;
    status?: string;
    notes?: string;
    locationCode?: string;
  }): Promise<AppointmentListRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const createdBy = await this.auditService.createdByFields();
    const locationCode = await this.tenantDb.resolveBusinessLocation(
      body.locationCode,
    );

    let customerId: string | null = null;
    if (body.customerName?.trim()) {
      const existing = await this.tenantDb.db.customer.findFirst({
        where: {
          tenantId,
          deletedAt: null,
          name: { equals: body.customerName.trim(), mode: 'insensitive' },
        },
      });
      if (existing) {
        customerId = existing.id;
      } else {
        const customer = await this.tenantDb.db.customer.create({
          data: {
            tenantId,
            name: body.customerName.trim(),
            ...createdBy,
          },
        });
        customerId = customer.id;
      }
    }

    const row = await this.tenantDb.db.appointment.create({
      data: {
        tenantId,
        customerId,
        stylistName: body.stylistName,
        serviceName: body.serviceName,
        servicePrice: body.servicePrice ?? 0,
        currency: body.currency ?? 'NGN',
        startTime: new Date(body.startTime),
        endTime: new Date(body.endTime),
        status: body.status ?? 'Booked',
        notes: body.notes ?? null,
        locationCode,
      },
      include: { customer: { select: { name: true } } },
    });

    await this.auditService.log({
      action: 'created',
      entityType: 'appointment',
      entityId: row.id,
      summary: `Booked ${body.serviceName} for ${body.stylistName}`,
    });

    return serializeAppointment(row);
  }
}
