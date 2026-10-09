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
import type { CreateDiscountRequest, UpdateDiscountRequest } from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { DiscountsService } from './discounts.service';

@Controller('discounts')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class DiscountsController {
  constructor(private readonly service: DiscountsService) {}

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.list({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Post()
  @Roles('manager', 'admin', 'super_admin')
  create(@Body() dto: CreateDiscountRequest) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('manager', 'admin', 'super_admin')
  update(@Param('id') id: string, @Body() dto: UpdateDiscountRequest) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles('manager', 'admin', 'super_admin')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
