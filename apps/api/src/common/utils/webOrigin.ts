const DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'https://vonos-web-7w14.vercel.app',
  'https://app.vonosautos.com',
  'https://app.vonosautosmarket.com',
];

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/$/, '');
}

export function resolveWebOrigins(): string[] {
  const origins = new Set<string>(DEFAULT_ORIGINS);

  const configured = process.env.WEB_ORIGIN ?? process.env.WEB_ORIGINS;
  if (configured) {
    for (const part of configured.split(',')) {
      const normalized = normalizeOrigin(part);
      if (normalized) origins.add(normalized);
    }
  }

  if (process.env.VERCEL_URL) {
    origins.add(`https://${process.env.VERCEL_URL}`);
  }

  return [...origins];
}

export function resolvePrimaryWebOrigin(): string {
  const configured = process.env.WEB_ORIGIN?.split(',')[0];
  if (configured) {
    return normalizeOrigin(configured);
  }
  return DEFAULT_ORIGINS[1] ?? DEFAULT_ORIGINS[0] ?? 'http://localhost:3000';
}
