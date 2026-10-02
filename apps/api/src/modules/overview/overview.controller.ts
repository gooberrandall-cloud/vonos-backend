import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OverviewService } from './overview.service';
import { CacheService } from '../../common/cache/cache.service';

@Controller('overview')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class OverviewController {
  constructor(
    private readonly overviewService: OverviewService,
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('dashboard')
  dashboard(@Query('from') from?: string, @Query('to') to?: string) {
    return this.overviewService.dashboard(from, to);
  }

  /** VA HQ6 home — finance KPIs + charts (cached). Prefer this over /dashboard for /VA/overview. */
  @Get('hq6-home')
  hq6Home(@Query('from') from?: string, @Query('to') to?: string) {
    return this.overviewService.hq6Home(from, to);
  }

  @Get('panels/stock-alert')
  stockAlertPanel() {
    return this.overviewService.stockAlertPanel();
  }

  @Get('panels/purchase-payment-dues')
  purchasePaymentDuesPanel() {
    return this.overviewService.purchasePaymentDuesPanel();
  }

  @Get('panels/sales-payment-dues')
  salesPaymentDuesPanel() {
    return this.overviewService.salesPaymentDuesPanel();
  }

  /** Fast path: KPIs + entity cards (no monthly trend / alerts). */
  @Get('group/summary')
  @Roles('super_admin')
  groupSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.overviewService.groupSummary(from, to);
  }

  /** Deferred: charts + alerts. */
  @Get('group/details')
  @Roles('super_admin')
  groupDetails(@Query('from') from?: string, @Query('to') to?: string) {
    return this.overviewService.groupDetails(from, to);
  }

  @Get('group')
  @Roles('super_admin')
  group(@Query('from') from?: string, @Query('to') to?: string) {
    return this.overviewService.group(from, to);
  }

  @Get('cache/stats')
  @Roles('super_admin')
  cacheStats() {
    return this.cache.stats();
  }

  /** Prisma pool metrics — use after a cold /VA/overview load to inspect pool waits. */
  @Get('cache/metrics')
  @Roles('super_admin')
  async cacheMetrics() {
    const metrics = await this.prisma.$metrics.json();
    const counters = metrics.counters ?? [];
    const gauges = metrics.gauges ?? [];
    const pick = (name: string) =>
      counters.find((c) => c.key === name)?.value ??
      gauges.find((g) => g.key === name)?.value ??
      null;
    return {
      pool: {
        connectionsOpen: pick('prisma_pool_connections_open'),
        connectionsBusy: pick('prisma_pool_connections_busy'),
        connectionsIdle: pick('prisma_pool_connections_idle'),
        connectionLimit: process.env.PRISMA_CONNECTION_LIMIT ?? null,
      },
      queries: {
        total: pick('prisma_client_queries_total'),
        active: pick('prisma_client_queries_active'),
        wait: pick('prisma_client_queries_wait'),
        waitMs: pick('prisma_client_queries_wait_ms'),
      },
      raw: metrics,
    };
  }

  @Post('cache/flush')
  @Roles('super_admin')
  async cacheFlush() {
    await this.cache.invalidatePrefix('');
    return { flushed: true };
  }
}
