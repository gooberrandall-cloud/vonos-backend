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
import type { PayContactDueRequest, SupplierFilters } from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { SuppliersService } from './suppliers.service';

@Controller('suppliers')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get('kpi-summary')
  kpiSummary() {
    return this.suppliersService.kpiSummary();
  }

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('purchaseDue') purchaseDue?: string,
    @Query('purchaseReturn') purchaseReturn?: string,
    @Query('advanceBalance') advanceBalance?: string,
    @Query('openingBalance') openingBalance?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('status') status?: 'active' | 'inactive',
    @Query('includeSummary') includeSummary?: string,
  ) {
    const filters: SupplierFilters = {
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
      purchaseDue: purchaseDue === 'true',
      purchaseReturn: purchaseReturn === 'true',
      advanceBalance: advanceBalance === 'true',
      openingBalance: openingBalance === 'true',
      assignedToUserId,
      status,
      includeSummary: includeSummary !== '0' && includeSummary !== 'false',
    };
    return this.suppliersService.list(filters);
  }

  @Post('import')
  @Roles('manager', 'admin', 'super_admin')
  import(@Body() body: { csv: string }) {
    return this.suppliersService.importCsv(body.csv ?? '');
  }

  @Get(':id/summary')
  getSummary(@Param('id') id: string) {
    return this.suppliersService.getSummary(id);
  }

  @Get(':id/ledger')
  getLedger(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.suppliersService.getLedger(
      id,
      cursor,
      limit ? Number(limit) : undefined,
    );
  }

  @Get(':id/stock-report')
  stockReport(@Param('id') id: string) {
    return this.suppliersService.stockReport(id);
  }

  @Get(':id/meta')
  getMeta(@Param('id') id: string) {
    return this.suppliersService.getMeta(id);
  }

  @Post(':id/pay-due')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  payDue(@Param('id') id: string, @Body() body: PayContactDueRequest) {
    return this.suppliersService.payDue(id, body);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.suppliersService.getById(id);
  }

  @Post()
  @Roles('staff', 'manager', 'admin', 'super_admin')
  create(
    @Body()
    body: {
      name: string;
      contactName?: string;
      email?: string;
      phone?: string;
      address?: string;
      notes?: string;
      taxNumber?: string | null;
      openingBalance?: number;
      assignedToUserId?: string;
    },
  ) {
    return this.suppliersService.create(body);
  }

  @Patch(':id')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  update(
    @Param('id') id: string,
    @Body()
    body: Partial<{
      name: string;
      contactName: string;
      email: string;
      phone: string;
      address: string;
      notes: string;
      openingBalance: number;
      assignedToUserId: string;
      status: 'active' | 'inactive';
    }>,
  ) {
    return this.suppliersService.update(id, body);
  }

  @Patch(':id/status')
  @Roles('manager', 'admin', 'super_admin')
  setStatus(
    @Param('id') id: string,
    @Body() body: { status: 'active' | 'inactive' },
  ) {
    return this.suppliersService.setStatus(id, body.status);
  }

  @Delete(':id')
  @Roles('admin', 'super_admin')
  remove(@Param('id') id: string) {
    return this.suppliersService.remove(id);
  }
}
