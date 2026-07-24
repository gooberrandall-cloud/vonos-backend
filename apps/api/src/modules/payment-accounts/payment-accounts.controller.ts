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
import { PaymentAccountsService } from './payment-accounts.service';
import type {
  CreatePaymentAccountRequest,
  PaymentAccountDepositRequest,
  PaymentAccountTransferRequest,
  UpdatePaymentAccountRequest,
} from '@vonos/types';

@Controller('payment-accounts')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class PaymentAccountsController {
  constructor(private readonly service: PaymentAccountsService) {}

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
  create(@Body() dto: CreatePaymentAccountRequest) {
    return this.service.create(dto);
  }

  @Post('transfer')
  @Roles('manager', 'admin', 'super_admin')
  transfer(@Body() dto: PaymentAccountTransferRequest) {
    return this.service.fundTransfer(dto);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Patch(':id')
  @Roles('manager', 'admin', 'super_admin')
  update(@Param('id') id: string, @Body() dto: UpdatePaymentAccountRequest) {
    return this.service.update(id, dto);
  }

  @Post(':id/deposit')
  @Roles('manager', 'admin', 'super_admin')
  deposit(
    @Param('id') id: string,
    @Body() dto: PaymentAccountDepositRequest,
  ) {
    return this.service.deposit(id, dto);
  }

  @Post(':id/close')
  @Roles('manager', 'admin', 'super_admin')
  close(@Param('id') id: string) {
    return this.service.close(id);
  }

  @Delete(':id')
  @Roles('admin', 'super_admin')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
