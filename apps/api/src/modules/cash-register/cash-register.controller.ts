import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { CashRegisterService } from './cash-register.service';

@Controller('cash-register')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class CashRegisterController {
  constructor(private readonly cashRegisterService: CashRegisterService) {}

  @Get('current')
  current() {
    return this.cashRegisterService.current();
  }

  @Get()
  history(@Query('limit') limit?: string) {
    return this.cashRegisterService.history(limit ? Number(limit) : undefined);
  }

  @Post('open')
  open(@Body() body: { openingBalance?: number; locationCode?: string }) {
    return this.cashRegisterService.open(body ?? {});
  }

  @Post('close')
  close(
    @Body()
    body: {
      closingAmount?: number;
      totalCardSlips?: number;
      totalCheques?: number;
      closingNote?: string;
    },
  ) {
    return this.cashRegisterService.close(body ?? {});
  }
}
