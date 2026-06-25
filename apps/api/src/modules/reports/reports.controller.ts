import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReportsService } from './reports.service';

@Controller('reports')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('summary')
  summary() {
    return this.reportsService.summary();
  }

  @Get('dashboard')
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
  run(
    @Query('reportId') reportId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportsService.run(reportId, from, to);
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
}
