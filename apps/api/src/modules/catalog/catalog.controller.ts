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
    @Query('locationCode') locationCode?: string,
    @Query('unit') unit?: string,
    @Query('brandName') brandName?: string,
    @Query('availableForRetail') availableForRetail?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('includeSummary') includeSummary?: string,
  ) {
    const filters: ItemFilters = {
      status,
      category,
      search,
      locationCode,
      unit,
      brandName,
      sortBy,
      sortDir: sortDir === 'asc' || sortDir === 'desc' ? sortDir : undefined,
      cursor,
      limit: limit ? Number(limit) : undefined,
      includeSummary:
        includeSummary === '0' || includeSummary === 'false'
          ? false
          : includeSummary === '1' || includeSummary === 'true'
            ? true
            : undefined,
    };
    if (availableForRetail === 'true') {
      filters.availableForRetail = true;
    } else if (availableForRetail === 'false') {
      filters.availableForRetail = false;
    }
    return this.catalogService.list(filters);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.catalogService.getById(id);
  }
}
