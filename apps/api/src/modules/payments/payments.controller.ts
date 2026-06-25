import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { PaymentsService } from './payments.service';

@Controller('payments')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Get()
  list(
    @Query('accountId') accountId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listPayments({
      accountId,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('account-book/:accountId')
  accountBook(@Param('accountId') accountId: string) {
    return this.service.listAccountBook(accountId);
  }
}
