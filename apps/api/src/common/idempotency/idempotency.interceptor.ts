import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import { EMPTY, Observable, from } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const HEADER = 'x-idempotency-key';
const TTL_MS = 24 * 60 * 60 * 1000;
const WAIT_MS = 8_000;
const WAIT_STEP_MS = 200;
const MAX_KEY_LEN = 128;

type AuthedRequest = Request & {
  user?: { sub?: string; userId?: string; id?: string };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (!key || key.length > MAX_KEY_LEN) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) return null;
  return key;
}

function scopeFromRequest(req: AuthedRequest): string {
  const user = req.user;
  const id = user?.sub ?? user?.userId ?? user?.id;
  return typeof id === 'string' && id.trim() ? id.trim() : 'system';
}

function requestPath(req: Request): string {
  return `${req.baseUrl || ''}${req.path || req.url || ''}`.split('?')[0] || '/';
}

function hashRequest(method: string, path: string, body: unknown): string {
  const payload =
    body === undefined || body === null
      ? ''
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
  return createHash('sha256')
    .update(`${method.toUpperCase()}:${path}:${payload}`)
    .digest('hex');
}

/**
 * Opt-in idempotency for mutating HTTP requests.
 * No X-Idempotency-Key → pass-through (daily ops unchanged).
 * Same scope+key+body → replay stored success; retries after failure re-run.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const res = http.getResponse<Response>();
    const method = (req.method || 'GET').toUpperCase();

    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return next.handle();
    }

    const key = normalizeKey(req.headers[HEADER]);
    if (!key) {
      return next.handle();
    }

    if (!this.prisma.isDatabaseConnected()) {
      // Don't block writes if the idempotency table isn't reachable — ops continue.
      this.logger.warn('Idempotency skipped: database not connected');
      return next.handle();
    }

    const scope = scopeFromRequest(req);
    const path = requestPath(req);
    const requestHash = hashRequest(method, path, req.body);

    return from(this.beginOrReplay(scope, key, method, path, requestHash, res)).pipe(
      switchMap((replayed) => {
        if (replayed) return EMPTY;
        return next.handle().pipe(
          tap({
            next: (data) => {
              void this.complete(scope, key, res.statusCode || 201, data);
            },
          }),
          catchError((err: unknown) => {
            void this.abandon(scope, key);
            throw err;
          }),
        );
      }),
      catchError((err: unknown) => {
        // beginOrReplay conflicts — surface to client; do not run handler.
        throw err;
      }),
    );
  }

  private async beginOrReplay(
    scope: string,
    key: string,
    method: string,
    path: string,
    requestHash: string,
    res: Response,
  ): Promise<boolean> {
    let existing: Awaited<
      ReturnType<PrismaService['idempotencyRecord']['findUnique']>
    > = null;
    try {
      existing = await this.prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope, key } },
      });
    } catch (error) {
      // Table missing (P2021) or Neon blip — fail open so writes continue.
      this.logger.warn(
        `Idempotency lookup failed open: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }

    if (existing) {
      if (existing.expiresAt.getTime() < Date.now()) {
        try {
          await this.prisma.idempotencyRecord.delete({ where: { id: existing.id } });
        } catch (error) {
          this.logger.warn(
            `Idempotency expire-delete failed open: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
      } else if (existing.requestHash !== requestHash) {
        throw new ConflictException(
          'Idempotency key was already used with a different request body',
        );
      } else if (existing.status === 'completed') {
        this.writeReplay(res, existing.responseStatus ?? 200, existing.responseBody);
        return true;
      } else {
        try {
          const done = await this.waitForCompleted(scope, key);
          if (done?.status === 'completed') {
            this.writeReplay(res, done.responseStatus ?? 200, done.responseBody);
            return true;
          }
        } catch (error) {
          this.logger.warn(
            `Idempotency wait failed open: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
        throw new ConflictException(
          'A request with this idempotency key is already in progress — retry shortly',
        );
      }
    }

    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          scope,
          key,
          method,
          path,
          requestHash,
          status: 'processing',
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      });
      return false;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        try {
          const raced = await this.waitForCompleted(scope, key);
          if (raced?.status === 'completed') {
            this.writeReplay(res, raced.responseStatus ?? 200, raced.responseBody);
            return true;
          }
        } catch (waitError) {
          this.logger.warn(
            `Idempotency race-wait failed open: ${
              waitError instanceof Error ? waitError.message : String(waitError)
            }`,
          );
          return false;
        }
        throw new ConflictException(
          'A request with this idempotency key is already in progress — retry shortly',
        );
      }
      // Table missing / DB blip — fail open so daily ops continue.
      this.logger.warn(
        `Idempotency begin failed open: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async waitForCompleted(scope: string, key: string) {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(WAIT_STEP_MS);
      try {
        const row = await this.prisma.idempotencyRecord.findUnique({
          where: { scope_key: { scope, key } },
        });
        if (!row) return null;
        if (row.status === 'completed') return row;
      } catch (error) {
        this.logger.warn(
          `Idempotency poll failed open: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      }
    }
    try {
      return await this.prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope, key } },
      });
    } catch {
      return null;
    }
  }

  private writeReplay(res: Response, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.status(status);
    if (body === undefined || body === null) {
      res.end();
      return;
    }
    res.json(body);
  }

  private async complete(
    scope: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.update({
        where: { scope_key: { scope, key } },
        data: {
          status: 'completed',
          responseStatus: status,
          responseBody:
            body === undefined
              ? Prisma.JsonNull
              : (body as Prisma.InputJsonValue),
        },
      });
    } catch (error) {
      this.logger.warn(
        `Idempotency complete failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async abandon(scope: string, key: string): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.deleteMany({
        where: { scope, key, status: 'processing' },
      });
    } catch (error) {
      this.logger.warn(
        `Idempotency abandon failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
