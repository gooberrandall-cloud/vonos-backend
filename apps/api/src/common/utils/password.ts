import { createHash, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 12;

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
