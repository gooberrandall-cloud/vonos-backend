import { Injectable, NotFoundException } from '@nestjs/common';
import type { Customer, CustomerFilters } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { buildCursorQuery } from '../../common/utils/pagination';
import { toIso, toNumber } from '../../common/utils/serializers';

@Injectable()
export class CustomersService {
  constructor(private readonly tenantDb: TenantDbService) {}

  async list(filters: CustomerFilters): Promise<Customer[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.customer.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { email: { contains: filters.search, mode: 'insensitive' } },
                { phone: { contains: filters.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        sales: {
          where: { deletedAt: null },
          select: { total: true },
        },
      },
      orderBy: { name: 'asc' },
      ...buildCursorQuery(filters.cursor, filters.limit ?? 50),
    });

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      email: row.email,
      phone: row.phone,
      totalSpend: row.sales.reduce(
        (sum, sale) => sum + toNumber(sale.total),
        0,
      ),
      visitCount: row.sales.length,
      createdByUserId: row.createdByUserId,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  }

  async getById(id: string): Promise<Customer> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        sales: {
          where: { deletedAt: null },
          select: { total: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Customer not found');
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      email: row.email,
      phone: row.phone,
      totalSpend: row.sales.reduce(
        (sum, sale) => sum + toNumber(sale.total),
        0,
      ),
      visitCount: row.sales.length,
      createdByUserId: row.createdByUserId,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }
}
