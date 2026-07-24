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
  CreateCustomerInput,
  CustomerFilters,
  PayContactDueRequest,
  UpdateCustomerInput,
} from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { CustomersService } from './customers.service';

@Controller('customers')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('sellDue') sellDue?: string,
    @Query('sellReturn') sellReturn?: string,
    @Query('advanceBalance') advanceBalance?: string,
    @Query('openingBalance') openingBalance?: string,
    @Query('hasNoSellMonths') hasNoSellMonths?: string,
    @Query('customerGroupId') customerGroupId?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('status') status?: 'active' | 'inactive',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('includeSummary') includeSummary?: string,
  ) {
    const months = Number(hasNoSellMonths);
    const filters: CustomerFilters = {
      search,
      sellDue: sellDue === 'true',
      sellReturn: sellReturn === 'true',
      advanceBalance: advanceBalance === 'true',
      openingBalance: openingBalance === 'true',
      hasNoSellMonths:
        months === 1 || months === 3 || months === 6 || months === 12
          ? (months as 1 | 3 | 6 | 12)
          : undefined,
      customerGroupId,
      assignedToUserId,
      status,
      from,
      to,
      cursor,
      limit: limit ? Number(limit) : undefined,
      includeSummary: includeSummary !== '0' && includeSummary !== 'false',
    };
    return this.customersService.list(filters);
  }

  @Post()
  @Roles('staff', 'manager', 'admin', 'super_admin')
  create(@Body() body: CreateCustomerInput) {
    return this.customersService.create(body);
  }

  @Post('import')
  @Roles('manager', 'admin', 'super_admin')
  import(@Body() body: { csv: string }) {
    return this.customersService.importCsv(body.csv ?? '');
  }

  @Get(':id/summary')
  getSummary(@Param('id') id: string) {
    return this.customersService.getSummary(id);
  }

  @Get(':id/view')
  getView(@Param('id') id: string) {
    return this.customersService.getView(id);
  }

  @Get(':id/contact')
  getContact(@Param('id') id: string) {
    return this.customersService.getContact(id);
  }

  @Get(':id/ledger')
  getLedger(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.customersService.getLedger(
      id,
      cursor,
      limit ? Number(limit) : undefined,
    );
  }

  @Post(':id/pay-due')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  payDue(@Param('id') id: string, @Body() body: PayContactDueRequest) {
    return this.customersService.payDue(id, body);
  }

  @Patch(':id/status')
  @Roles('manager', 'admin', 'super_admin')
  setStatus(
    @Param('id') id: string,
    @Body() body: { status: 'active' | 'inactive' },
  ) {
    return this.customersService.setStatus(id, body.status);
  }

  @Patch(':id')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  update(@Param('id') id: string, @Body() body: UpdateCustomerInput) {
    return this.customersService.update(id, body);
  }

  @Delete(':id')
  @Roles('admin', 'super_admin')
  remove(@Param('id') id: string) {
    return this.customersService.remove(id);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.customersService.getById(id);
  }
}
