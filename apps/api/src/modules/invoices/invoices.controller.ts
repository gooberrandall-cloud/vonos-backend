import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import type { InvoiceKind } from '@vonos/types';
import { InvoicesService } from './invoices.service';

@Controller('invoices')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  @Get()
  list(
    @Query('kind') kind?: InvoiceKind,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('customerId') customerId?: string,
    @Query('supplierId') supplierId?: string,
    @Query('employeeRecordId') employeeRecordId?: string,
    @Query('saleId') saleId?: string,
    @Query('stockMovementId') stockMovementId?: string,
    @Query('expenseId') expenseId?: string,
    @Query('payrollId') payrollId?: string,
    @Query('payrollGroupId') payrollGroupId?: string,
    @Query('jobId') jobId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list({
      kind,
      paymentStatus,
      from,
      to,
      search,
      customerId,
      supplierId,
      employeeRecordId,
      saleId,
      stockMovementId,
      expenseId,
      payrollId,
      payrollGroupId,
      jobId,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }
}
