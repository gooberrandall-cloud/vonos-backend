import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  ItemFilters,
  ItemLocationStockInput,
  StockStatus,
  CsvImportResult,
} from '@vonos/types';
import {
  Roles,
  type AuthenticatedUser,
} from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import {
  userHasAnyPermission,
  userHasPermission,
} from '../../common/utils/userPermissions';
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
    @Query('stockHomesOnly') stockHomesOnlyRaw?: string,
  ) {
    // Cap high enough for VAG stock sliding-window “warm more” (UI grows 50→100→…).
    // First paint still requests 50; do not restore the old 10k dump.
    const limit = Math.min(
      Math.max(Number.parseInt(limitRaw ?? '10', 10) || 10, 1),
      500,
    );
    return this.itemsService.stockAvailability(search, {
      limit,
      entityCode,
      availability:
        availability === 'available' || availability === 'unavailable'
          ? availability
          : 'all',
      stockHomesOnly:
        stockHomesOnlyRaw === '1' || stockHomesOnlyRaw === 'true'
          ? true
          : undefined,
    });
  }

  /** Read-only VW/VISP/VSP qty for a batch of SKUs (product list/view). */
  @Get('peer-stock')
  peerStock(@Query('skus') skusRaw?: string) {
    const skus = (skusRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.itemsService.peerStockBySkus(skus);
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
    @Query('includeSummary') includeSummary?: string,
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
      includeSummary: includeSummary === 'false' ? false : undefined,
    };
    if (availableForRetail === 'true') {
      filters.availableForRetail = true;
    } else if (availableForRetail === 'false') {
      filters.availableForRetail = false;
    }
    return this.itemsService.list(filters);
  }

  @Post('import')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  import(
    @Body() body: { csv: string },
    @Req() req: { user: AuthenticatedUser },
  ) {
    if (!userHasPermission(req.user, 'product.create')) {
      throw new ForbiddenException('Missing product.create');
    }
    return this.itemsService.importCsv(body.csv ?? '');
  }

  @Post('import-opening-stock')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  importOpeningStock(
    @Body() body: { csv: string },
    @Req() req: { user: AuthenticatedUser },
  ) {
    if (!userHasPermission(req.user, 'product.opening_stock')) {
      throw new ForbiddenException('Missing product.opening_stock');
    }
    return this.itemsService.importOpeningStockCsv(body.csv ?? '');
  }

  @Post('bulk-price')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  bulkUpdatePrice(
    @Body()
    body: {
      category?: string;
      itemIds?: string[];
      adjustmentType: 'fixed' | 'percentage';
      adjustmentValue: number;
    },
    @Req() req: { user: AuthenticatedUser },
  ) {
    if (!userHasPermission(req.user, 'product.update')) {
      throw new ForbiddenException('Missing product.update');
    }
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

  @Get(':id/opening-stock')
  listOpeningStock(@Param('id') id: string) {
    return this.itemsService.listOpeningStock(id);
  }

  /**
   * Add/edit opening stock (dated OS/… movements + on-hand qty).
   * POST/PUT/PATCH all accepted — older proxies sometimes only allow PATCH on :id trees.
   */
  @Post(':id/opening-stock')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  saveOpeningStockPost(
    @Param('id') id: string,
    @Body()
    body: {
      locationCode: string;
      costPrice?: number;
      rows: Array<{
        id?: string;
        quantity: number;
        unitCost: number;
        date: string;
        note?: string;
      }>;
    },
    @Req() req: { user: AuthenticatedUser },
  ) {
    if (!userHasPermission(req.user, 'product.opening_stock')) {
      throw new ForbiddenException('Missing product.opening_stock');
    }
    return this.itemsService.saveOpeningStock(id, body);
  }

  @Patch(':id/opening-stock')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  saveOpeningStockPatch(
    @Param('id') id: string,
    @Body()
    body: {
      locationCode: string;
      costPrice?: number;
      rows: Array<{
        id?: string;
        quantity: number;
        unitCost: number;
        date: string;
        note?: string;
      }>;
    },
    @Req() req: { user: AuthenticatedUser },
  ) {
    if (!userHasPermission(req.user, 'product.opening_stock')) {
      throw new ForbiddenException('Missing product.opening_stock');
    }
    return this.itemsService.saveOpeningStock(id, body);
  }

  /**
   * Manual stock correction — raises or lowers on-hand qty and writes an
   * `ADJ/…` movement so the change shows in Product Stock History.
   * Counterpart to opening stock, which is append-only and can only add.
   * Reachable via product "Add Opening Stock" or the purchase "Edit purchase
   * & Stock Adjustment" checkbox (procurement roles typically hold the latter).
   */
  @Post(':id/adjust-stock')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  adjustStock(
    @Param('id') id: string,
    @Body()
    body: {
      direction: 'increase' | 'decrease';
      quantity: number;
      locationCode?: string;
      reason?: string;
      date?: string;
    },
    @Req() req: { user: AuthenticatedUser },
  ) {
    if (
      !userHasAnyPermission(req.user, [
        'product.opening_stock',
        'purchase.update',
      ])
    ) {
      throw new ForbiddenException('Missing product.opening_stock');
    }
    return this.itemsService.adjustStock(id, body);
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
      imageUrl?: string;
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
      subCategory: string;
      description: string;
      imageUrl: string;
      barcodeType: string;
      unit: string;
      weight: string;
      carModel: string;
      enableImei: boolean;
      preparationMinutes: number;
      quantity: number;
      binLocation: string;
      locationCode: string;
      reorderPoint: number;
      costPrice: number;
      sellPrice: number | null;
      brandId: string;
      brandName: string;
      currency: string;
      status: StockStatus;
      availableForRetail: boolean;
      locationStock: ItemLocationStockInput[];
      openingStock: {
        locationCode: string;
        costPrice?: number;
        rows: Array<{
          id?: string;
          quantity: number;
          unitCost: number;
          date: string;
          note?: string;
        }>;
      };
    }>,
  ) {
    return this.itemsService.update(id, body);
  }

  /**
   * Gated by the TenantRole `product.delete` key, not the JWT role: the
   * products list offers Delete to anyone with that checkbox, but the JWT
   * role is derived from the role name and user-management keys only
   * (`mapTenantRoleToJwtRole`), so a PARTS AUDITOR or Manager1 would
   * otherwise see the button and get 403 here.
   */
  @Delete(':id')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  remove(@Param('id') id: string, @Req() req: { user: AuthenticatedUser }) {
    if (!userHasPermission(req.user, 'product.delete')) {
      throw new ForbiddenException('Missing product.delete');
    }
    return this.itemsService.remove(id);
  }
}
