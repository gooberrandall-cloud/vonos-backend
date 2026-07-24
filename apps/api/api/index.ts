import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Express } from 'express';

let appPromise: Promise<Express> | undefined;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<unknown> {
  if (!appPromise) {
    const { getExpressApp } = await import('../dist/bootstrap.js');
    appPromise = getExpressApp();
  }
  const expressApp = await appPromise;
  return expressApp(req, res);
}
