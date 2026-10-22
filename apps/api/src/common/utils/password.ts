import { createHash, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcrypt';

/** Interactive login cost — OWASP-accepted; cost 12 was ~4× slower on verify. */
const BCRYPT_ROUNDS = 10;

const BCRYPT_COST_RE = /^\$2[aby]?\$(\d{2})\$/;

/** Legacy seed hasher — verified for migration, not used for new passwords. */
export function devPasswordHash(password: string): string {
  return `dev:${createHash('sha256').update(password).digest('hex')}`;
}

function verifyDevPassword(password: string, passwordHash: string): boolean {
  if (!passwordHash.startsWith('dev:')) return false;
  const expected = devPasswordHash(password);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(passwordHash));
  } catch {
    return false;
  }
}

/** Extract bcrypt cost factor, or null if not a bcrypt hash. */
export function bcryptCost(passwordHash: string): number | null {
  const match = BCRYPT_COST_RE.exec(passwordHash);
  if (!match) return null;
  const cost = Number(match[1]);
  return Number.isFinite(cost) ? cost : null;
}

/** True when hash should be rewritten to current policy after a successful verify. */
export function needsPasswordRehash(passwordHash: string): boolean {
  if (passwordHash.startsWith('dev:')) return true;
  const cost = bcryptCost(passwordHash);
  if (cost == null) return false;
  return cost !== BCRYPT_ROUNDS;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  if (passwordHash.startsWith('dev:')) {
    return verifyDevPassword(password, passwordHash);
  }
  return bcrypt.compare(password, passwordHash);
}

export function isDevPasswordHash(passwordHash: string): boolean {
  return passwordHash.startsWith('dev:');
}

/** New passwords: ≥8 chars, letter, number, and symbol — keep in sync with web Zod schemas. */
export function isStrongPassword(password: string): boolean {
  if (!password || password.length < 8) return false;
  if (!/[A-Za-z]/.test(password)) return false;
  if (!/\d/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false;
  return true;
}

export const STRONG_PASSWORD_HINT =
  'Password must be at least 8 characters and include a letter, a number, and a symbol';

