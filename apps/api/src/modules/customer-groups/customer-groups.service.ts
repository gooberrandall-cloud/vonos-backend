import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CustomerGroup,
  CreateCustomerGroupRequest,
  UpdateCustomerGroupRequest,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { toIso, toNumber } from '../../common/utils/serializers';

@Injectable()
export class CustomerGroupsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  async list(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    discount?: 'has' | 'none';
  } = {}): Promise<CustomerGroup[]> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'string',
    });
    const rows = await this.tenantDb.db.customerGroup.findMany({
      where: {
        tenantId: this.tenantDb.requireTenantId(),
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(filters.discount === 'has'
          ? { discountPercent: { gt: 0 } }
          : filters.discount === 'none'
            ? { discountPercent: { lte: 0 } }
            : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      discountPercent: toNumber(row.discountPercent),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  }

  async create(dto: CreateCustomerGroupRequest): Promise<CustomerGroup> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.customerGroup.create({
      data: {
        tenantId,
        name: dto.name,
        discountPercent: dto.discountPercent ?? 0,
      },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      discountPercent: toNumber(row.discountPercent),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async update(
    id: string,
    dto: UpdateCustomerGroupRequest,
  ): Promise<CustomerGroup> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.customerGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Customer group not found');
    const row = await this.tenantDb.db.customerGroup.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.discountPercent !== undefined
          ? { discountPercent: dto.discountPercent }
          : {}),
      },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      discountPercent: toNumber(row.discountPercent),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.customerGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Customer group not found');
    await this.tenantDb.db.customerGroup.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
