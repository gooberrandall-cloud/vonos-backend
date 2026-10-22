import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { CafeTableStatus } from '@vonos/types';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { CafeTablesService } from './cafe-tables.service';

@Controller('cafe-tables')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class CafeTablesController {
  constructor(private readonly cafeTablesService: CafeTablesService) {}

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.cafeTablesService.list({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.cafeTablesService.getById(id);
  }

  @Post()
  create(
    @Body()
    body: {
      label: string;
      capacity?: number;
      status?: CafeTableStatus;
    },
  ) {
    return this.cafeTablesService.create(body);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() body: { status: CafeTableStatus },
  ) {
    return this.cafeTablesService.updateStatus(id, body.status);
  }
}
