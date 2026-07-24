import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import { AppModule } from './app.module';
import { resolveWebOrigins } from './common/utils/webOrigin';

async function createNestApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.use(compression());
  app.use(cookieParser());
  app.enableCors({
    origin: resolveWebOrigins(),
    credentials: true,
  });
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
