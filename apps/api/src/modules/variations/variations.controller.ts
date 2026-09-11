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
  CreateVariationTemplateRequest,
  UpdateVariationTemplateRequest,
} from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { VariationsService } from './variations.service';

@Controller('variations')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class VariationsController {
  constructor(private readonly service: VariationsService) {}

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
  create(@Body() dto: CreateVariationTemplateRequest) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('manager', 'admin', 'super_admin')
  update(@Param('id') id: string, @Body() dto: UpdateVariationTemplateRequest) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles('manager', 'admin', 'super_admin')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
