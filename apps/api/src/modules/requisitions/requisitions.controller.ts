import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
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
  list() {
    return this.requisitionsService.list();
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
    },
  ) {
    return this.requisitionsService.create(body);
  }
}
