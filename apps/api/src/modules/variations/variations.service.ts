import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateVariationTemplateRequest,
  UpdateVariationTemplateRequest,
  VariationTemplate,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { toIso } from '../../common/utils/serializers';

@Injectable()
export class VariationsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  private mapRow(row: {
    id: string;
    tenantId: string;
    name: string;
    values: string[];
    createdAt: Date;
    updatedAt: Date;
  }): VariationTemplate {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      values: row.values,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async list(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
  } = {}): Promise<VariationTemplate[]> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'string',
    });
    const rows = await this.tenantDb.db.variationTemplate.findMany({
      where: {
        tenantId: this.tenantDb.requireTenantId(),
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    return rows.map((row) => this.mapRow(row));
  }

  async create(dto: CreateVariationTemplateRequest): Promise<VariationTemplate> {
    const tenantId = this.tenantDb.requireTenantId();
    const values = dto.values.map((v) => v.trim()).filter(Boolean);
    const row = await this.tenantDb.db.variationTemplate.create({
      data: {
        tenantId,
        name: dto.name.trim(),
        values,
      },
    });
    return this.mapRow(row);
  }

  async update(
    id: string,
    dto: UpdateVariationTemplateRequest,
  ): Promise<VariationTemplate> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.variationTemplate.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Variation template not found');

    const row = await this.tenantDb.db.variationTemplate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.values !== undefined
          ? { values: dto.values.map((v) => v.trim()).filter(Boolean) }
          : {}),
      },
    });
    return this.mapRow(row);
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.variationTemplate.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Variation template not found');
    await this.tenantDb.db.variationTemplate.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
