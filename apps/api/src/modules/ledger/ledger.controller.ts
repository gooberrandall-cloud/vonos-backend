import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { LedgerEntryType } from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { LedgerService } from './ledger.service';

@Controller('ledger')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Get('summary')
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.ledgerService.summary(from, to);
  }

  @Get('categories')
  categories(@Query('from') from?: string, @Query('to') to?: string) {
    return this.ledgerService.categories(from, to);
  }

  @Get('group/categories')
  @Roles('super_admin')
  groupCategories(@Query('from') from?: string, @Query('to') to?: string) {
    return this.ledgerService.groupCategories(from, to);
  }

  @Get('group/summary')
  @Roles('super_admin')
  groupSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.ledgerService.groupSummary(from, to);
  }

  @Get('group/by-entity')
  @Roles('super_admin')
  groupByEntity(@Query('from') from?: string, @Query('to') to?: string) {
    return this.ledgerService.groupByEntity(from, to);
  }

  @Get('group')
  @Roles('super_admin')
  groupList(
    @Query('type') type?: LedgerEntryType,
    @Query('category') category?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ledgerService.groupList({
      type,
      category,
      from,
      to,
      search,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get()
  list(
    @Query('type') type?: LedgerEntryType,
    @Query('category') category?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ledgerService.list({
      type,
      category,
      from,
      to,
      search,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post()
  @Roles('manager', 'admin', 'super_admin')
  createManual(
    @Body()
    body: {
      type: 'expense';
      amount: number;
      category: string;
      description: string;
      date?: string;
      currency?: string;
    },
  ) {
    return this.ledgerService.createManual(body);
  }
}
