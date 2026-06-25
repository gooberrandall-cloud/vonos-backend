import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import { AppModule } from './app.module';

function resolveWebOrigin(): string {
  if (process.env.WEB_ORIGIN) {
    return process.env.WEB_ORIGIN;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return 'http://localhost:3000';
}

async function createNestApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.enableCors({
    origin: resolveWebOrigin(),
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
  await app.listen(port);
}
