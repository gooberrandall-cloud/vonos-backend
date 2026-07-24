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
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { Roles } from '../../common/decorators/roles.decorator';
import { CustomerGroupsService } from './customer-groups.service';
import type {
  CreateCustomerGroupRequest,
  UpdateCustomerGroupRequest,
} from '@vonos/types';

@Controller('customer-groups')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class CustomerGroupsController {
  constructor(private readonly service: CustomerGroupsService) {}

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('discount') discount?: 'has' | 'none',
  ) {
    return this.service.list({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
      discount,
    });
  }

  @Post()
  @Roles('admin', 'manager')
  create(@Body() dto: CreateCustomerGroupRequest) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerGroupRequest) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
