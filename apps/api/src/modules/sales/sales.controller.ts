import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { SaleFilters } from '@vonos/types';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { SalesService } from './sales.service';

@Controller('sales')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const filters: SaleFilters = {
      search,
      cursor,
      limit: limit ? Number(limit) : undefined,
    };
    return this.salesService.list(filters);
  }

  @Post()
  create(
    @Body()
    body: {
      reference: string;
      customerName?: string;
      locationCode?: string;
      lines: Array<{
        itemId?: string;
        sku: string;
        name: string;
        quantity: number;
        unitPrice: number;
      }>;
      currency?: string;
      date?: string;
      payments?: Array<{
        amount: number;
        method?: string;
        note?: string;
        accountId?: string;
      }>;
    },
  ) {
    return this.salesService.create(body);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.salesService.getById(id);
  }
}
