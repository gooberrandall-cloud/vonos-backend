import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { ItemFilters, StockStatus } from '@vonos/types';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { CatalogService } from './catalog.service';

@Controller('catalog')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  list(
    @Query('status') status?: StockStatus,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const filters: ItemFilters = {
      status,
      category,
      search,
      cursor,
      limit: limit ? Number(limit) : undefined,
    };
    return this.catalogService.list(filters);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.catalogService.getById(id);
  }
}
