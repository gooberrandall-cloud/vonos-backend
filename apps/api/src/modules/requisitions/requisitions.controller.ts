import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { RequisitionLine } from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { RequisitionsService } from './requisitions.service';

@Controller('requisitions')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class RequisitionsController {
  constructor(private readonly requisitionsService: RequisitionsService) {}

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.requisitionsService.list({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Get('incoming')
  listIncoming(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.requisitionsService.listIncoming({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.requisitionsService.getById(id);
  }

  @Post()
  create(
    @Body()
    body: {
      reference: string;
      jobId?: string;
      notes?: string;
      sourceTenantCode?: string;
      lines?: RequisitionLine[];
    },
  ) {
    return this.requisitionsService.create(body);
  }

  @Post(':id/cancel')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  cancel(@Param('id') id: string) {
    return this.requisitionsService.cancel(id);
  }

  @Post(':id/approve')
  @Roles('manager', 'admin', 'super_admin')
  approve(@Param('id') id: string) {
    return this.requisitionsService.approve(id);
  }

  @Post(':id/reject')
  @Roles('manager', 'admin', 'super_admin')
  reject(@Param('id') id: string) {
    return this.requisitionsService.reject(id);
  }

  @Post(':id/fulfill')
  @Roles('manager', 'admin', 'super_admin')
  fulfill(@Param('id') id: string) {
    return this.requisitionsService.fulfill(id);
  }
}
