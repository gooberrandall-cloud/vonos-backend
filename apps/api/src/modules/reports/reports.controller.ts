import { Controller, Get, Patch, Body, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { ProfitLossBreakdownTab } from '@vonos/types';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReportsService } from './reports.service';
import { ReportActionsService } from './report-actions.service';

@Controller('reports')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly reportActionsService: ReportActionsService,
  ) {}

  @Get('summary')
  summary() {
    return this.reportsService.summary();
  }

  @Get('dashboard')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  dashboard(
    @Query('tab') tab?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportsService.dashboard(tab ?? 'valuation', from, to);
  }

  @Get('group')
  @Roles('super_admin')
  group(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reportsService.group(from, to);
  }

  @Get('run')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  run(
    @Query('reportId') reportId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('mode') mode?: 'shell' | 'pl-core' | 'pl-summary' | 'pl-breakdown' | 'full',
    @Query('breakdownTab') breakdownTab?: ProfitLossBreakdownTab,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('customerId') customerId?: string,
    @Query('customerGroupId') customerGroupId?: string,
    @Query('locationCode') locationCode?: string,
    @Query('accountId') accountId?: string,
    @Query('category') category?: string,
    @Query('brandId') brandId?: string,
    @Query('paymentMethod') paymentMethod?: string,
    @Query('supplierId') supplierId?: string,
    @Query('view') view?: string,
    @Query('taxTable') taxTable?: string,
  ) {
    return this.reportsService.run(reportId, from, to, mode, breakdownTab, {
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
      customerId,
      customerGroupId,
      locationCode,
      accountId,
      category,
      brandId,
      paymentMethod,
      supplierId,
      view:
        view === 'by-category' || view === 'by-brand' || view === 'detailed'
          ? view
          : undefined,
      taxTable:
        taxTable === 'purchases' || taxTable === 'sales' ? taxTable : undefined,
    });
  }

  @Get('group/run')
  @Roles('super_admin')
  runGroup(
    @Query('reportId') reportId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportsService.runGroup(reportId, from, to);
  }

  /** HQ6 adjustProductStock — fix per-location quantity mismatch. */
  @Patch('actions/fix-location-stock')
  @Roles('manager', 'admin', 'super_admin')
  fixLocationStock(
    @Body()
    body: {
      itemId: string;
      locationCode: string;
      binLocation?: string;
      quantity: number;
    },
  ) {
    return this.reportActionsService.fixLocationStock(body);
  }

  /** HQ6 updateStockExpiryReport — set expiry on inbound movement line. */
  @Patch('actions/movement-line-expiry')
  @Roles('manager', 'admin', 'super_admin')
  updateMovementLineExpiry(
    @Body()
    body: {
      movementId: string;
      lineSku: string;
      expDate: string;
    },
  ) {
    return this.reportActionsService.updateMovementLineExpiry(body);
  }
}
