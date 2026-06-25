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
import type {
  MovementSource,
  MovementStatus,
  MovementType,
} from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { StockMovementsService } from './stock-movements.service';

@Controller('stock-movements')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class StockMovementsController {
  constructor(private readonly movementsService: StockMovementsService) {}

  @Get()
  list(
    @Query('type') type?: MovementType,
    @Query('status') status?: MovementStatus,
    @Query('source') source?: MovementSource,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.movementsService.list({
      type,
      status,
      source,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.movementsService.getById(id);
  }

  @Post()
  @Roles('staff', 'manager', 'admin', 'super_admin')
  create(
    @Body()
    body: {
      type: MovementType;
      reference: string;
      status?: MovementStatus;
      lines: Array<{
        itemId: string;
        sku: string;
        name: string;
        quantity: number;
        unitCost?: number;
      }>;
      notes?: string;
      supplierId?: string;
      source?: MovementSource;
      date?: string;
    },
  ) {
    return this.movementsService.create(body);
  }

  @Patch(':id/status')
  @Roles('manager', 'admin', 'super_admin')
  updateStatus(
    @Param('id') id: string,
    @Body() body: { status: MovementStatus },
  ) {
    return this.movementsService.updateStatus(id, body.status);
  }
}

@Controller('transfers')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class TransfersController {
  constructor(private readonly movementsService: StockMovementsService) {}

  @Get('zones')
  zones() {
    return this.movementsService.transferZones();
  }

  @Get()
  list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.movementsService.listTransfers({
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
