import { BadRequestException, Injectable } from '@nestjs/common';
import type { ReportsDashboard } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ItemsService } from '../items/items.service';
import { buildAppointmentReports } from './aggregators/appointmentReports';
import { buildGroupReports } from './aggregators/groupReports';
import { buildJobReports } from './aggregators/jobReports';
import { buildStockReports } from './aggregators/stockReports';
import { buildTransactionReports } from './aggregators/transactionReports';
import { runGroupReport, runReportForTenant } from './reportRunner';

export interface ReportsSummary {
  totalSku: number;
  todayInbound: number;
  todayOutbound: number;
  stockValue: number;
  currency: string;
  totalUnits: number;
  avgTurnover: number;
  stockValuesLabel: string;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly itemsService: ItemsService,
  ) {}

  async summary(): Promise<ReportsSummary> {
    const kpi = await this.itemsService.kpiSummary();
    const totalUnitsResult = await this.tenantDb.db.item.aggregate({
      where: { deletedAt: null },
      _sum: { quantity: true },
    });
    const totalUnits = totalUnitsResult._sum.quantity ?? 0;
    const stockValueM = kpi.stockValue / 1_000_000;
    const stockValuesLabel = `₦ ${stockValueM.toFixed(1)}M`;

    return {
      ...kpi,
      totalUnits,
      avgTurnover:
        totalUnits > 0 ? Number((kpi.totalSku / totalUnits).toFixed(2)) : 0,
      stockValuesLabel,
    };
  }

  async dashboard(
    tab: string,
    from?: string,
    to?: string,
  ): Promise<ReportsDashboard> {
    const tenantId = this.tenantDb.requireTenantId();
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { archetype: true },
    });
    if (!tenant) {
      throw new BadRequestException('Tenant not found');
    }

    const db = this.tenantDb.db;
    const archetype = tenant.archetype;

    switch (archetype) {
      case 'stock':
        return buildStockReports(
          db,
          (tab as 'valuation' | 'movement' | 'lowstock') || 'valuation',
          from,
          to,
        );
      case 'transaction':
        return buildTransactionReports(
          db,
          (tab as 'sales' | 'closeout') || 'sales',
          from,
          to,
        );
      case 'job':
        return buildJobReports(
          db,
          (tab as 'costing' | 'turnaround') || 'costing',
          from,
          to,
        );
      case 'appointment':
        return buildAppointmentReports(
          db,
          (tab as 'stylist' | 'noshow') || 'stylist',
          from,
          to,
        );
      default: {
        const _exhaustive: never = archetype;
        return _exhaustive;
      }
    }
  }

  async group(from?: string, to?: string): Promise<ReportsDashboard> {
    return buildGroupReports(this.prisma, from, to);
  }

  async run(
    reportId: string,
    from?: string,
    to?: string,
  ): Promise<ReportsDashboard> {
    const tenantId = this.tenantDb.requireTenantId();
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { archetype: true },
    });
    if (!tenant) {
      throw new BadRequestException('Tenant not found');
    }
    return runReportForTenant(
      reportId,
      {
        db: this.tenantDb.db,
        prisma: this.prisma,
        tenantId,
        archetype: tenant.archetype,
      },
      from,
      to,
    );
  }

  async runGroup(reportId: string, from?: string, to?: string) {
    return runGroupReport(this.prisma, reportId, from, to);
  }
}
