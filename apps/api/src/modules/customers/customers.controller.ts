import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { CustomerFilters } from '@vonos/types';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { CustomersService } from './customers.service';

@Controller('customers')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const filters: CustomerFilters = {
      search,
      cursor,
      limit: limit ? Number(limit) : undefined,
    };
    return this.customersService.list(filters);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.customersService.getById(id);
  }
}
