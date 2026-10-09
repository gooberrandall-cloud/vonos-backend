import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

type ErrorBody = {
  statusCode: number;
  message: string | string[];
  error: string;
};

const DB_UNAVAILABLE_MESSAGE =
  'We can’t reach the database right now — please try again in a moment.';

const DB_CONNECTIVITY_CODES = new Set(['P1001', 'P1017', 'P2024']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function flattenHttpMessage(payload: string | object): string | string[] {
  if (typeof payload === 'string') return payload;
  if (isRecord(payload) && 'message' in payload) {
    const message = payload.message;
    if (typeof message === 'string' || Array.isArray(message)) {
      return message;
    }
  }
  return 'Request failed';
}

function prismaTargetLabel(meta: unknown): string | null {
  if (!isRecord(meta)) return null;
  const target = meta.target;
  if (Array.isArray(target) && target.length > 0) {
    return target.map(String).join(', ');
  }
  if (typeof target === 'string' && target.trim()) return target;
  const field_name = meta.field_name;
  if (typeof field_name === 'string' && field_name.trim()) return field_name;
  return null;
}

/** Duck-type Prisma codes — `instanceof` fails when duplicate @prisma/client copies load. */
function prismaErrorCode(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
  if (isRecord(error) && typeof error.code === 'string' && /^P\d{4}$/.test(error.code)) {
    return error.code;
  }
  return null;
}

function errorMessageText(error: unknown): string {
  if (error instanceof Error) return error.message?.trim() ?? '';
  return String(error ?? '').trim();
}

/** Neon / pooler / network outages — never expose hostnames or Prisma dumps to clients. */
function isDatabaseConnectivityFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  const code = prismaErrorCode(error);
  if (code && DB_CONNECTIVITY_CODES.has(code)) return true;

  const lower = errorMessageText(error).toLowerCase();
  return (
    lower.includes("can't reach database") ||
    lower.includes('cannot reach database') ||
    lower.includes('database server is running') ||
    lower.includes('timed out fetching a new connection') ||
    lower.includes('connection terminated unexpectedly') ||
    lower.includes('connection refused') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('server has closed the connection') ||
    lower.includes('error in postgresql connection') ||
    /neon\.tech:\d+/.test(lower) ||
    lower.includes('invalid `prisma.') ||
    lower.includes('invalid `this.prisma.')
  );
}

function looksLikeInternalDatabaseDump(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("can't reach database") ||
    lower.includes('cannot reach database') ||
    lower.includes('database server is running') ||
    lower.includes('invalid `prisma') ||
    lower.includes('invalid `this.prisma') ||
    lower.includes('invocation in') ||
    /neon\.tech/.test(lower) ||
    /ep-[a-z0-9-]+\./.test(lower)
  );
}

function mapPrismaError(error: {
  code: string;
  meta?: unknown;
}): {
  status: number;
  message: string;
  error: string;
} {
  if (DB_CONNECTIVITY_CODES.has(error.code)) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: DB_UNAVAILABLE_MESSAGE,
      error: 'Service Unavailable',
    };
  }

  switch (error.code) {
    case 'P2002': {
      const fields = prismaTargetLabel(error.meta);
      return {
        status: HttpStatus.CONFLICT,
        message: fields
          ? `A record with that ${fields} already exists`
          : 'That record already exists',
        error: 'Conflict',
      };
    }
    case 'P2003': {
      const fields = prismaTargetLabel(error.meta);
      return {
        status: HttpStatus.BAD_REQUEST,
        message: fields
          ? `Related record missing or invalid (${fields})`
          : 'Related record missing or invalid',
        error: 'Bad Request',
      };
    }
    case 'P2025':
      return {
        status: HttpStatus.NOT_FOUND,
        message: 'That record was not found',
        error: 'Not Found',
      };
    case 'P2028':
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'The operation timed out — please try again',
        error: 'Bad Request',
      };
    case 'P2021':
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message:
          'Database schema is out of date — a required table is missing. Run pending migrations.',
        error: 'Service Unavailable',
      };
    default:
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Database request failed',
        error: 'Bad Request',
      };
  }
}

/**
 * Never leak raw "Internal server error" — always return a usable message.
 * HttpExceptions keep their status/body; Prisma + unknown Errors are mapped.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Something went wrong — please try again';
    let errorName = 'Error';

    if (isDatabaseConnectivityFailure(exception)) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = DB_UNAVAILABLE_MESSAGE;
      errorName = 'Service Unavailable';
      this.logger.error(
        `Database unavailable: ${errorMessageText(exception) || '(no message)'}`,
      );
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      message = flattenHttpMessage(payload);
      errorName =
        isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : exception.name.replace(/Exception$/, '') || 'Error';
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError ||
      prismaErrorCode(exception)
    ) {
      const code = prismaErrorCode(exception)!;
      const meta =
        exception instanceof Prisma.PrismaClientKnownRequestError
          ? exception.meta
          : isRecord(exception)
            ? exception.meta
            : undefined;
      const mapped = mapPrismaError({ code, meta });
      status = mapped.status;
      message = mapped.message;
      errorName = mapped.error;
      this.logger.warn(`Prisma ${code}: ${mapped.message}`);
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Invalid data sent to the database';
      errorName = 'Bad Request';
      this.logger.warn(`Prisma validation: ${exception.message}`);
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = DB_UNAVAILABLE_MESSAGE;
      errorName = 'Service Unavailable';
      this.logger.error(`Prisma init: ${exception.message}`);
    } else if (exception instanceof Error) {
      const raw = exception.message?.trim() ?? '';
      const lower = raw.toLowerCase();
      const multerCode =
        isRecord(exception) && typeof exception.code === 'string'
          ? exception.code
          : '';

      if (
        multerCode === 'LIMIT_FILE_SIZE' ||
        lower.includes('file too large')
      ) {
        status = HttpStatus.PAYLOAD_TOO_LARGE;
        message = 'Image must be 12MB or smaller';
        errorName = 'Payload Too Large';
      } else if (
        exception.name === 'PayloadTooLargeError' ||
        lower.includes('request entity too large') ||
        lower.includes('payload too large')
      ) {
        status = HttpStatus.PAYLOAD_TOO_LARGE;
        message =
          'Upload is too large — try a smaller image (max 12MB after compression)';
        errorName = 'Payload Too Large';
      } else if (
        raw &&
        lower !== 'internal server error' &&
        !lower.includes('internal server error') &&
        !looksLikeInternalDatabaseDump(raw)
      ) {
        // Prefer the real message over Nest's opaque "Internal server error"
        message = raw;
      }
      this.logger.error(
        `Unhandled ${exception.name}: ${raw || '(no message)'}`,
        exception.stack,
      );
    } else {
      this.logger.error(`Unhandled non-Error: ${String(exception)}`);
    }

    // Never send Nest's default opaque copy or Prisma dumps to clients.
    if (typeof message === 'string') {
      const trimmed = message.trim();
      if (trimmed.toLowerCase() === 'internal server error') {
        message = 'Something went wrong — please try again';
      } else if (looksLikeInternalDatabaseDump(trimmed)) {
        message = DB_UNAVAILABLE_MESSAGE;
        status = HttpStatus.SERVICE_UNAVAILABLE;
        errorName = 'Service Unavailable';
      }
    }

    const body: ErrorBody = {
      statusCode: status,
      message,
      error: errorName,
    };
    response.status(status).json(body);
  }
}
