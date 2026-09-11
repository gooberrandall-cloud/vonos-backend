import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
    @Query('unlinkedOnly') unlinkedOnly?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('includeSummary') includeSummary?: string,
  ) {
    return this.service.listPayments({
      accountId,
      unlinkedOnly:
        unlinkedOnly === '1' ||
        unlinkedOnly === 'true' ||
        unlinkedOnly === 'yes',
      from,
      to,
      search,
      cursor,
      limit: limit ? Number(limit) : undefined,
      includeSummary:
        includeSummary === '0' || includeSummary === 'false'
          ? false
          : includeSummary === '1' || includeSummary === 'true'
            ? true
            : undefined,
    });
  }

  /** Assign payment account to unlinked sale payments (+ book credits). */
  @Post('bulk-link')
  bulkLink(
    @Body()
    body: {
      accountId: string;
      paymentIds?: string[];
      allUnlinked?: boolean;
      limit?: number;
    },
  ) {
    return this.service.bulkLinkToAccount(body);
  }

  @Get('account-book/:accountId')
  accountBook(
    @Param('accountId') accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listAccountBook(accountId, {
      from,
      to,
      search,
      type,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
