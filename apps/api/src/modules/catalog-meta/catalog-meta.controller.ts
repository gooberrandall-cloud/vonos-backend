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
  CreateBrandInput,
  CreateProductCategoryInput,
  CreateProductUnitInput,
  CreateSellingPriceGroupInput,
  CreateWarrantyInput,
  Warranty,
} from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { CatalogMetaService } from './catalog-meta.service';

function listFilters(
  cursor?: string,
  limit?: string,
  search?: string,
) {
  return {
    cursor,
    limit: limit ? Number(limit) : undefined,
    search,
  };
}

@Controller('catalog-meta')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class CatalogMetaController {
  constructor(private readonly service: CatalogMetaService) {}

  @Get('categories')
  categories(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listCategories(listFilters(cursor, limit, search));
  }

  @Post('categories')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  createCategory(@Body() body: CreateProductCategoryInput) {
    return this.service.createCategory(body);
  }

  @Patch('categories/:id')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  updateCategory(
    @Param('id') id: string,
    @Body() body: { name?: string; shortCode?: string | null; description?: string | null },
  ) {
    return this.service.updateCategory(id, body);
  }

  @Delete('categories/:id')
  @Roles('admin', 'super_admin')
  removeCategory(@Param('id') id: string) {
    return this.service.removeCategory(id);
  }

  @Get('brands')
  brands(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listBrands(listFilters(cursor, limit, search));
  }

  @Post('brands')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  createBrand(@Body() body: CreateBrandInput) {
    return this.service.createBrand(body);
  }

  @Patch('brands/:id')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  updateBrand(
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string | null },
  ) {
    return this.service.updateBrand(id, body);
  }

  @Delete('brands/:id')
  @Roles('admin', 'super_admin')
  removeBrand(@Param('id') id: string) {
    return this.service.removeBrand(id);
  }

  @Get('units')
  units(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listUnits(listFilters(cursor, limit, search));
  }

  @Post('units')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  createUnit(@Body() body: CreateProductUnitInput) {
    return this.service.createUnit(body);
  }

  @Patch('units/:id')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  updateUnit(
    @Param('id') id: string,
    @Body() body: { name?: string; shortName?: string; allowDecimal?: boolean },
  ) {
    return this.service.updateUnit(id, body);
  }

  @Delete('units/:id')
  @Roles('admin', 'super_admin')
  removeUnit(@Param('id') id: string) {
    return this.service.removeUnit(id);
  }

  @Get('warranties')
  warranties(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listWarranties(listFilters(cursor, limit, search));
  }

  @Post('warranties')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  createWarranty(@Body() body: CreateWarrantyInput) {
    return this.service.createWarranty(body);
  }

  @Patch('warranties/:id')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  updateWarranty(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string | null;
      duration?: number;
      durationType?: Warranty['durationType'];
    },
  ) {
    return this.service.updateWarranty(id, body);
  }

  @Delete('warranties/:id')
  @Roles('admin', 'super_admin')
  removeWarranty(@Param('id') id: string) {
    return this.service.removeWarranty(id);
  }

  @Get('price-groups')
  priceGroups(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listPriceGroups(listFilters(cursor, limit, search));
  }

  @Post('price-groups')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  createPriceGroup(@Body() body: CreateSellingPriceGroupInput) {
    return this.service.createPriceGroup(body);
  }

  @Patch('price-groups/:id')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  updatePriceGroup(
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string | null; isActive?: boolean },
  ) {
    return this.service.updatePriceGroup(id, body);
  }

  @Delete('price-groups/:id')
  @Roles('admin', 'super_admin')
  removePriceGroup(@Param('id') id: string) {
    return this.service.removePriceGroup(id);
  }
}
