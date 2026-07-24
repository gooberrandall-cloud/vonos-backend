import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const logger = new Logger('TransientDbRetry');

/** Neon free-tier / pooler blips — safe to retry at the *top-level* query. */
const TRANSIENT_CODES = new Set(['P1001', 'P1017', 'P2024']);

/**
 * Transaction errors must NOT be retried at the per-query level (PgBouncer +
 * interactive $transaction). Retrying mid-tx causes "Transaction not found".
 */
const NO_RETRY_CODES = new Set(['P2028']);

const DEFAULT_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function isTransactionError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    NO_RETRY_CODES.has(error.code)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Transaction API error') ||
    message.includes('Transaction not found') ||
    message.includes('Unable to start a transaction') ||
    message.includes('Transaction already closed')
  );
}

function isTransientPrismaError(error: unknown): boolean {
  if (isTransactionError(error)) return false;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return TRANSIENT_CODES.has(error.code);
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Can't reach database server") ||
    message.includes('Timed out fetching a new connection') ||
    message.includes('Connection terminated unexpectedly')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry transient Neon/Prisma connectivity errors (P1001 wake, P2024 pool timeout).
 * Never retries interactive-transaction failures (P2028) — those must be retried
 * as a whole transaction, not mid-flight queries.
 */
export async function withTransientDbRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; label?: string },
): Promise<T> {
  const attempts = opts?.attempts ?? DEFAULT_ATTEMPTS;
  const label = opts?.label ?? 'query';
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientPrismaError(error) || attempt === attempts) {
        throw error;
      }
      const waitMs = BASE_DELAY_MS * attempt;
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : 'transient';
      logger.warn(
        `${label} ${code} attempt ${attempt}/${attempts}; retry in ${waitMs}ms`,
      );
      await delay(waitMs);
    }
  }

  throw lastError;
}

/** Retry an entire interactive/batch $transaction on transient connectivity loss. */
export async function withTransientTransactionRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; label?: string },
): Promise<T> {
  const attempts = opts?.attempts ?? DEFAULT_ATTEMPTS;
  const label = opts?.label ?? '$transaction';
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable =
        isTransientPrismaError(error) || isTransactionError(error);
      if (!retryable || attempt === attempts) {
        throw error;
      }
      const waitMs = BASE_DELAY_MS * attempt;
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : 'tx';
      logger.warn(
        `${label} ${code} attempt ${attempt}/${attempts}; retry whole tx in ${waitMs}ms`,
      );
      await delay(waitMs);
    }
  }

  throw lastError;
}
