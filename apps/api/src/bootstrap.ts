import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { resolveWebOrigins } from './common/utils/webOrigin';

/** Product image uploads + large JSON (Express default is 100kb → "entity too large"). */
const BODY_LIMIT = '15mb';

/** Load apps/api/.env into process.env when keys are unset (local nest start). */
function loadLocalEnvFile(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* ignore */
  }
}

loadLocalEnvFile();

/**
 * Some macOS/router DNS setups make Node `dns.lookup` (getaddrinfo) fail for
 * Neon CNAME hosts while dig/resolve4 still work — Prisma then reports P1001.
 * Rewrite DATABASE_URL to the resolved IPv4 + Neon `endpoint=` option.
 */
async function ensureNeonHostnameResolvable(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) return;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }

  const hostname = url.hostname;
  if (!hostname.includes('neon.tech')) return;

  const dns = await import('dns/promises');
  try {
    await dns.lookup(hostname);
    return;
  } catch {
    /* fall through */
  }

  try {
    const addresses = await dns.resolve4(
      hostname.endsWith('neon.tech') ? hostname : hostname,
    ).catch(async () => dns.resolve4('eu-west-2.aws.neon.tech'));
    const ip = addresses[0];
    if (!ip) return;

    const endpoint = hostname.split('.')[0]?.replace(/-pooler$/, '') ?? '';
    url.hostname = ip;
    if (endpoint) {
      url.searchParams.set('options', `endpoint=${endpoint}`);
    }
    url.searchParams.set('sslmode', url.searchParams.get('sslmode') ?? 'require');
    process.env.DATABASE_URL = url.toString();
    console.warn(
      `[dns] Neon host ${hostname} failed getaddrinfo; using ${ip} (endpoint=${endpoint})`,
    );
  } catch (error) {
    console.warn(
      `[dns] Could not resolve Neon host ${hostname}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function createNestApp(): Promise<INestApplication> {
  await ensureNeonHostnameResolvable();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });
  app.enableShutdownHooks();
  app.use(compression());
  app.use(cookieParser());
  app.enableCors({
    origin: resolveWebOrigins(),
    credentials: true,
  });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

export async function getExpressApp(): Promise<Express> {
  const app = await createNestApp();
  return app.getHttpAdapter().getInstance() as Express;
}

export async function bootstrap(): Promise<void> {
  const app = await createNestApp();
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen(port, host);
}
