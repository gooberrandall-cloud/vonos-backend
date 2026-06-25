import { BadRequestException, Injectable } from '@nestjs/common';
import type { GroupOverviewDashboard, OverviewDashboard } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildGroupOverview } from './groupOverview';
import {
  buildAppointmentOverview,
  buildJobOverview,
  buildStockOverview,
  buildTransactionOverview,
} from './overviewAggregators';

@Injectable()
export class OverviewService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
  ) {}

  async dashboard(from?: string, to?: string): Promise<OverviewDashboard> {
    const tenantId = this.tenantDb.requireTenantId();
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { archetype: true, code: true },
    });
    if (!tenant) {
      throw new BadRequestException('Tenant not found');
    }

    const db = this.tenantDb.db;
    const archetype = tenant.archetype;

    switch (archetype) {
      case 'stock':
        return buildStockOverview(db, tenant.code, from, to);
      case 'transaction':
        return buildTransactionOverview(db, tenant.code, from, to);
      case 'job':
        return buildJobOverview(db, tenant.code, from, to);
      case 'appointment':
        return buildAppointmentOverview(db, from, to);
      default: {
        const _exhaustive: never = archetype;
        return _exhaustive;
      }
    }
  }

  async group(from?: string, to?: string): Promise<GroupOverviewDashboard> {
    return buildGroupOverview(this.prisma, from, to);
  }
}
