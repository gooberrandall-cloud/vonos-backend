/**
 * Refresh TenantEntitySnapshot rows and warm group overview Redis/L1 cache.
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/refresh-entity-snapshots.ts
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CacheService } from '../../src/common/cache/cache.service';
import { refreshTenantEntitySnapshots } from '../../src/common/utils/tenantEntitySnapshot';
import { warmHotPathsCache } from '../../src/common/utils/warmHotPathsCache';

function loadUrls(): string[] {
  const envPath = join(__dirname, '../../.env');
  const env = readFileSync(envPath, 'utf8');
  const raw = env
    .match(/^DATABASE_URL=(.+)$/m)?.[1]
    ?.replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('DATABASE_URL not found');
  const withParams = (url: string) => {
    const sep = url.includes('?') ? '&' : '?';
    const ssl = /sslmode=/.test(url) ? '' : '&sslmode=require';
    return `${url}${sep}connection_limit=5&pool_timeout=60${ssl}`;
  };
  return [...new Set([withParams(raw.replace('-pooler.', '.')), withParams(raw)])];
}

async function connect(): Promise<PrismaClient> {
  for (const url of loadUrls()) {
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      return prisma;
    } catch {
      await prisma.$disconnect().catch(() => undefined);
    }
  }
  throw new Error('Could not connect via direct or pooler DATABASE_URL');
}

async function main() {
  const prisma = await connect();
  const cache = new CacheService();
  await cache.onModuleInit();

  try {
    console.log('Refreshing TenantEntitySnapshot for all group tenants…');
    const rows = await refreshTenantEntitySnapshots(prisma);
    console.log(`Snapshots: ${rows} tenant row(s) upserted.`);

    console.log('Warming hot-path caches (overview, finance, reports, VA)…');
    try {
      await warmHotPathsCache(prisma, cache);
      console.log('Done: snapshots refreshed and hot-path caches warmed.');
    } catch (warmErr) {
      console.warn(
        'Snapshots refreshed; cache warm failed (API bootstrap will retry):',
        warmErr instanceof Error ? warmErr.message : warmErr,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
