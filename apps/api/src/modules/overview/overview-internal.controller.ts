import {
  Controller,
  Headers,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { OverviewService } from './overview.service';

/** Cron-safe cache warm — no JWT; requires GROUP_WARM_SECRET header. */
@Controller('internal/overview')
export class OverviewInternalController {
  constructor(private readonly overviewService: OverviewService) {}

  @Post('group-warm')
  async groupWarm(
    @Headers('x-group-warm-secret') secret: string | undefined,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const expected = process.env.GROUP_WARM_SECRET;
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid warm secret');
    }
    return this.overviewService.warmGroupCache(from, to);
  }
}
