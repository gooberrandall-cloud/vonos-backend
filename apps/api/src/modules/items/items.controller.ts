import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  ItemFilters,
  ItemLocationStockInput,
  StockStatus,
  CsvImportResult,
} from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { ItemsService } from './items.service';

@Controller('items')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Get('kpi-summary')
  kpiSummary() {
    return this.itemsService.kpiSummary();
  }

  @Get('stock-availability')
  stockAvailability(
    @Query('search') search?: string,
    @Query('limit') limitRaw?: string,
    @Query('entityCode') entityCode?: string,
    @Query('availability') availability?: string,
  ) {
    const limit = Math.min(
      Math.max(Number.parseInt(limitRaw ?? '10', 10) || 10, 1),
      50,
    );
    return this.itemsService.stockAvailability(search, {
      limit,
      entityCode,
      availability:
        availability === 'available' || availability === 'unavailable'
          ? availability
          : 'all',
    });
  }

  /** Available qty at a source tenant for a SKU (requisition planning). */
  @Get('source-availability')
  sourceAvailability(
    @Query('sku') sku?: string,
    @Query('sourceTenantCode') sourceTenantCode?: string,
  ) {
    return this.itemsService.sourceAvailability(
      sku ?? '',
      sourceTenantCode ?? 'VW',
    );
  }

  @Get()
  list(
    @Query('status') status?: StockStatus,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('locationCode') locationCode?: string,
    @Query('unit') unit?: string,
    @Query('brandName') brandName?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('availableForRetail') availableForRetail?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
  ) {
    const filters: ItemFilters & { availableForRetail?: boolean } = {
      status,
      category,
      search,
      locationCode,
      unit,
      brandName,
      cursor,
      limit: limit ? Number(limit) : undefined,
      sortBy,
      sortDir: sortDir === 'asc' || sortDir === 'desc' ? sortDir : undefined,
    };
    if (availableForRetail === 'true') {
      filters.availableForRetail = true;
    } else if (availableForRetail === 'false') {
      filters.availableForRetail = false;
    }
    return this.itemsService.list(filters);
  }

  @Post('import')
  @Roles('manager', 'admin', 'super_admin')
  import(@Body() body: { csv: string }) {
    return this.itemsService.importCsv(body.csv ?? '');
  }

  @Post('import-opening-stock')
  @Roles('manager', 'admin', 'super_admin')
  importOpeningStock(@Body() body: { csv: string }) {
    return this.itemsService.importOpeningStockCsv(body.csv ?? '');
  }

  @Post('bulk-price')
  @Roles('manager', 'admin', 'super_admin')
  bulkUpdatePrice(
    @Body()
    body: {
      category?: string;
      itemIds?: string[];
      adjustmentType: 'fixed' | 'percentage';
      adjustmentValue: number;
    },
  ) {
    return this.itemsService.bulkUpdatePrice(body);
  }

  @Get(':id/meta')
  getMeta(@Param('id') id: string) {
    return this.itemsService.getMeta(id);
  }

  @Get(':id/stock-history')
  stockHistory(@Param('id') id: string) {
    return this.itemsService.stockHistory(id);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.itemsService.getById(id);
  }

  @Post()
  @Roles('staff', 'manager', 'admin', 'super_admin')
  create(
    @Body()
    body: {
      sku: string;
      name: string;
      category?: string;
      subCategory?: string;
      description?: string;
      barcodeType?: string;
      unit?: string;
      weight?: string;
      carModel?: string;
      enableImei?: boolean;
      preparationMinutes?: number;
      quantity?: number;
      binLocation?: string;
      locationCode?: string;
      reorderPoint?: number;
      costPrice: number;
      sellPrice?: number;
      currency?: string;
      status?: StockStatus;
      availableForRetail?: boolean;
      brandId?: string;
      brandName?: string;
      locationStock?: ItemLocationStockInput[];
    },
  ) {
    return this.itemsService.create(body);
  }

  @Patch(':id')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  update(
    @Param('id') id: string,
    @Body()
    body: Partial<{
      sku: string;
      name: string;
      category: string;
      quantity: number;
      binLocation: string;
      locationCode: string;
      reorderPoint: number;
      costPrice: number;
      currency: string;
      status: StockStatus;
      availableForRetail: boolean;
      locationStock: ItemLocationStockInput[];
    }>,
  ) {
    return this.itemsService.update(id, body);
  }

  @Delete(':id')
  @Roles('admin', 'super_admin')
  remove(@Param('id') id: string) {
    return this.itemsService.remove(id);
  }
}
