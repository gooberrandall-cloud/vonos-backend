import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Redis } from '@upstash/redis';

/** Short in-process layer so warm overview/report hits stay sub-300ms without a Redis RTT. */
const L1_TTL_MS = 30_000;

/** VAG group overview keys stay in L1 for the full Redis TTL (avoid Upstash RTT). */
const L1_LONG_TTL_MS = 900_000;
const L1_LONG_KEY_PREFIXES = [
  'cacheVer:',
  'group-overview',
  'ledger-group-',
  'report-group',
  'report-group-run',
  'stock-availability',
  'entity-overview',
  'hq6-home:',
  'ledger:',
  'report-dash:',
  'workforce:',
  'invoice-settings:',
  'list:',
  'auth:tv:',
  'legacy-map:',
];

@Injectable()
export class CacheService implements OnModuleInit {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | null = null;
  private readonly fallback = new Map<
    string,
    { data: string; expiresAt: number }
  >();
  private readonly l1 = new Map<string, { data: string; expiresAt: number }>();

  onModuleInit() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (url && token) {
      this.redis = new Redis({ url, token });
      this.logger.log('Upstash Redis connected');
    } else {
      this.logger.warn(
        'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — using in-memory fallback cache',
      );
    }
  }

  get isRedis(): boolean {
    return this.redis !== null;
  }

  private versionKey(tenantId: string): string {
    return `cacheVer:${tenantId}`;
  }

  private readL1<T>(key: string): T | null {
    const entry = this.l1.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.l1.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.data) as T;
    } catch {
      this.l1.delete(key);
      return null;
    }
  }

  private isLongLivedKey(key: string): boolean {
    return L1_LONG_KEY_PREFIXES.some(
      (prefix) => key.startsWith(prefix) || key.includes(`:${prefix}`),
    );
  }

  private writeL1(key: string, serialized: string, ttlSeconds: number): void {
    const longLived = this.isLongLivedKey(key);
    const capMs = longLived ? L1_LONG_TTL_MS : L1_TTL_MS;
    const ttlMs = Math.min(ttlSeconds * 1000, capMs);
    this.l1.set(key, { data: serialized, expiresAt: Date.now() + ttlMs });
  }

  private clearL1Prefix(prefix: string): void {
    for (const key of this.l1.keys()) {
      if (key.startsWith(prefix) || key.includes(prefix)) {
        this.l1.delete(key);
      }
    }
  }

  async getTenantCacheVersion(tenantId: string): Promise<number> {
    const version = await this.get<number>(this.versionKey(tenantId));
    return version ?? 1;
  }

  async bumpTenantVersion(tenantId: string): Promise<void> {
    const current = await this.getTenantCacheVersion(tenantId);
    // Drop L1 entries for this tenant so bump takes effect immediately.
    for (const key of [...this.l1.keys()]) {
      if (key.includes(tenantId) || key.startsWith(`v${current}:`)) {
        this.l1.delete(key);
      }
    }
    await this.set(this.versionKey(tenantId), current + 1, 60 * 60 * 24 * 30);
  }

  async tenantScopedKey(tenantId: string, key: string): Promise<string> {
    const version = await this.getTenantCacheVersion(tenantId);
    return `v${version}:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const fromL1 = this.readL1<T>(key);
      if (fromL1 !== null) return fromL1;

      if (this.redis) {
        const raw = await this.redis.get<string>(key);
        if (raw === null || raw === undefined) return null;
        const value = (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
        this.writeL1(
          key,
          typeof raw === 'string' ? raw : JSON.stringify(raw),
          this.isLongLivedKey(key) ? L1_LONG_TTL_MS / 1000 : L1_TTL_MS / 1000,
        );
        return value;
      }
      const entry = this.fallback.get(key);
      if (!entry || entry.expiresAt < Date.now()) {
        if (entry) this.fallback.delete(key);
        return null;
      }
      this.writeL1(
        key,
        entry.data,
        this.isLongLivedKey(key) ? L1_LONG_TTL_MS / 1000 : L1_TTL_MS / 1000,
      );
      return JSON.parse(entry.data) as T;
    } catch (err) {
      this.logger.warn(`Cache get error for key "${key}": ${err}`);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      this.writeL1(key, serialized, ttlSeconds);
      if (this.redis) {
        await this.redis.set(key, serialized, { ex: ttlSeconds });
        return;
      }
      this.fallback.set(key, {
        data: serialized,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    } catch (err) {
      this.logger.warn(`Cache set error for key "${key}": ${err}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      for (const key of keys) this.l1.delete(key);
      if (this.redis) {
        await this.redis.del(...keys);
        return;
      }
      for (const key of keys) {
        this.fallback.delete(key);
      }
    } catch (err) {
      this.logger.warn(`Cache del error: ${err}`);
    }
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    try {
      this.clearL1Prefix(prefix);
      if (this.redis) {
        // Prefer SCAN over KEYS — KEYS blocks / is discouraged on managed Redis.
        let cursor = '0';
        do {
          const [next, keys] = await this.redis.scan(cursor, {
            match: `${prefix}*`,
            count: 100,
          });
          cursor = String(next);
          if (keys.length > 0) {
            await this.redis.del(...keys);
          }
        } while (cursor !== '0');
        return;
      }
      for (const key of this.fallback.keys()) {
        if (key.startsWith(prefix)) {
          this.fallback.delete(key);
        }
      }
    } catch (err) {
      this.logger.warn(`Cache invalidatePrefix error for "${prefix}": ${err}`);
    }
  }

  async stats(): Promise<{ backend: 'redis' | 'memory'; keyCount: number }> {
    if (this.redis) {
      const info = await this.redis.dbsize();
      return { backend: 'redis', keyCount: info };
    }
    let count = 0;
    const now = Date.now();
    for (const entry of this.fallback.values()) {
      if (entry.expiresAt > now) count++;
    }
    return { backend: 'memory', keyCount: count };
  }
}
