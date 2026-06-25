import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { Roles } from '../../common/decorators/roles.decorator';
import { OverviewService } from './overview.service';

@Controller('overview')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class OverviewController {
  constructor(private readonly overviewService: OverviewService) {}

  @Get('dashboard')
  dashboard(@Query('from') from?: string, @Query('to') to?: string) {
    return this.overviewService.dashboard(from, to);
  }

  @Get('group')
  @Roles('super_admin')
  group(@Query('from') from?: string, @Query('to') to?: string) {
    return this.overviewService.group(from, to);
  }
}
