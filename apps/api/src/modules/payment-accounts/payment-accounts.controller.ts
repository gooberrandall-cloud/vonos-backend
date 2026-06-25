import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { PaymentAccountsService } from './payment-accounts.service';

@Controller('payment-accounts')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class PaymentAccountsController {
  constructor(private readonly service: PaymentAccountsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }
}
