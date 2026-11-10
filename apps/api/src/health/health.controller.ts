import { Controller, Get } from '@nestjs/common';
import { CacheService } from '../common/cache/cache.service';
import { PrismaService } from '../common/prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Get()
  async check() {
    let database: 'connected' | 'disconnected' = 'disconnected';
    if (this.prisma.isDatabaseConnected()) {
      database = 'connected';
    } else {
      try {
        await this.prisma.$queryRaw`SELECT 1`;
        database = 'connected';
      } catch {
        database = 'disconnected';
      }
    }

    const cacheStats = await this.cache.stats();

    return {
      status: 'ok',
      service: 'vonos-api',
      database,
      cache: {
        backend: cacheStats.backend,
        keyCount: cacheStats.keyCount,
        redisConfigured: this.cache.isRedis,
      },
    };
  }
}
