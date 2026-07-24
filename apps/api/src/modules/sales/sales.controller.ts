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
import type { SaleFilters } from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
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
    @Query('status') status?: SaleFilters['status'],
    @Query('saleStatus') saleStatus?: SaleFilters['saleStatus'],
    @Query('returnsOnly') returnsOnly?: string,
    @Query('shipmentsOnly') shipmentsOnly?: string,
    @Query('locationCode') locationCode?: string,
    @Query('customerId') customerId?: string,
    @Query('jobId') jobId?: string,
    @Query('paymentStatus') paymentStatus?: SaleFilters['paymentStatus'],
    @Query('paymentMethod') paymentMethod?: string,
    @Query('cleanerUserId') cleanerUserId?: string,
    @Query('serviceStaffEmployeeId') serviceStaffEmployeeId?: string,
    @Query('createdByUserId') createdByUserId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
    @Query('includeSummary') includeSummary?: string,
  ) {
    const filters: SaleFilters = {
      search,
      status,
      saleStatus,
      returnsOnly: returnsOnly === 'true',
      shipmentsOnly: shipmentsOnly === 'true',
      locationCode,
      customerId,
      jobId,
      paymentStatus,
      paymentMethod,
      cleanerUserId,
      serviceStaffEmployeeId,
      createdByUserId,
      from,
      to,
      cursor,
      limit: limit ? Number(limit) : undefined,
      sortBy,
      sortDir: sortDir === 'asc' || sortDir === 'desc' ? sortDir : undefined,
      includeSummary: includeSummary !== '0' && includeSummary !== 'false',
    };
    return this.salesService.list(filters);
  }

  @Post('import')
  @Roles('manager', 'admin', 'super_admin')
  import(@Body() body: { csv: string }) {
    return this.salesService.importCsv(body.csv ?? '');
  }

  @Post()
  create(
    @Body()
    body: {
      reference: string;
      customerName?: string;
      locationCode?: string;
      paymentMethod?: string;
      cleanerUserId?: string;
      cleanerName?: string;
      serviceStaffEmployeeId?: string;
      lines: Array<{
        itemId?: string;
        sku: string;
        name: string;
        quantity: number;
        unitPrice: number;
        discountAmount?: number;
        createPurchase?: boolean;
        sourceTenantCode?: string;
      }>;
      currency?: string;
      date?: string;
      status?: SaleFilters['saleStatus'] | 'final';
      shippingStatus?: string;
      shippingAddress?: string;
      trackingNumber?: string;
      discountAmount?: number;
      taxAmount?: number;
      notes?: string;
      customerId?: string;
      jobId?: string;
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

  @Get(':id/meta')
  getMeta(@Param('id') id: string) {
    return this.salesService.getMeta(id);
  }

  @Get(':id/view')
  getView(@Param('id') id: string) {
    return this.salesService.getView(id);
  }

  @Get(':id/payments')
  listPayments(@Param('id') id: string) {
    return this.salesService.listPayments(id);
  }

  @Get(':id/invoice-url')
  getInvoiceUrl(@Param('id') id: string) {
    return this.salesService.getInvoiceShareUrl(id);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.salesService.getById(id);
  }

  @Post(':id/finalize')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  finalize(
    @Param('id') id: string,
    @Body()
    body: {
      payments?: Array<{
        amount: number;
        method?: string;
        note?: string;
        accountId?: string;
      }>;
    },
  ) {
    return this.salesService.finalize(id, body);
  }

  @Post(':id/return')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  createReturn(
    @Param('id') id: string,
    @Body()
    body: {
      disposition: 'refunded' | 'restocked' | 'written_off';
      notes?: string;
      lines?: Array<{ saleLineId: string; quantity: number }>;
    },
  ) {
    return this.salesService.createReturn(id, body);
  }

  @Patch(':id/shipping')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  updateShipping(
    @Param('id') id: string,
    @Body()
    body: {
      shippingStatus?: string | null;
      shippingAddress?: string | null;
      trackingNumber?: string | null;
    },
  ) {
    return this.salesService.updateShipping(id, body);
  }

  @Delete(':id')
  @Roles('admin', 'super_admin')
  remove(@Param('id') id: string) {
    return this.salesService.remove(id);
  }
}
