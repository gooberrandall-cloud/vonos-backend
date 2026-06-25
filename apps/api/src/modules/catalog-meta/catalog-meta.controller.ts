import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { CatalogMetaService } from './catalog-meta.service';

@Controller('catalog-meta')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class CatalogMetaController {
  constructor(private readonly service: CatalogMetaService) {}

  @Get('categories')
  categories() {
    return this.service.listCategories();
  }

  @Get('brands')
  brands() {
    return this.service.listBrands();
  }

  @Get('units')
  units() {
    return this.service.listUnits();
  }

  @Get('warranties')
  warranties() {
    return this.service.listWarranties();
  }

  @Get('price-groups')
  priceGroups() {
    return this.service.listPriceGroups();
  }
}
