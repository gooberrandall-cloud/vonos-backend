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
  MovementSource,
  MovementStatus,
  MovementType,
  PayContactDueRequest,
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
    @Query('locationCode') locationCode?: string,
    @Query('supplierId') supplierId?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('paymentMethod') paymentMethod?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
    @Query('includeSummary') includeSummary?: string,
  ) {
    return this.movementsService.list({
      type,
      status,
      source,
      locationCode,
      supplierId,
      paymentStatus: paymentStatus as
        | 'paid'
        | 'due'
        | 'partial'
        | 'overdue'
        | undefined,
      paymentMethod,
      search,
      from,
      to,
      cursor,
      limit: limit ? Number(limit) : undefined,
      sortBy,
      sortDir,
      // Opt-in: COUNT over large movement tables is expensive; rows-first is default.
      includeSummary: includeSummary === '1' || includeSummary === 'true',
    });
  }

  @Get(':id/payments')
  listPayments(@Param('id') id: string) {
    return this.movementsService.listPayments(id);
  }

  @Get(':id/view')
  getView(@Param('id') id: string) {
    return this.movementsService.getView(id);
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
      paymentStatus?: 'paid' | 'due' | 'partial' | 'overdue';
      paymentMethod?: string;
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
      locationCode?: string;
      date?: string;
    },
  ) {
    return this.movementsService.create(body);
  }

  @Post(':id/pay')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  pay(@Param('id') id: string, @Body() body: PayContactDueRequest) {
    return this.movementsService.pay(id, body);
  }

  @Patch(':id/status')
  @Roles('manager', 'admin', 'super_admin')
  updateStatus(
    @Param('id') id: string,
    @Body() body: { status: MovementStatus },
  ) {
    return this.movementsService.updateStatus(id, body.status);
  }

  @Delete(':id')
  @Roles('admin', 'super_admin')
  remove(@Param('id') id: string) {
    return this.movementsService.remove(id);
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
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ) {
    return this.movementsService.listTransfers({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
      from,
      to,
      status,
    });
  }
}
