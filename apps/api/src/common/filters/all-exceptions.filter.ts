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

function mapPrismaError(error: Prisma.PrismaClientKnownRequestError): {
  status: number;
  message: string;
  error: string;
} {
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
    case 'P1001':
    case 'P1017':
    case 'P2024':
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Database is temporarily unavailable — try again shortly',
        error: 'Service Unavailable',
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
        message: error.message?.split('\n')[0]?.trim() || 'Database request failed',
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

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      message = flattenHttpMessage(payload);
      errorName =
        isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : exception.name.replace(/Exception$/, '') || 'Error';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = mapPrismaError(exception);
      status = mapped.status;
      message = mapped.message;
      errorName = mapped.error;
      this.logger.warn(`Prisma ${exception.code}: ${mapped.message}`);
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Invalid data sent to the database';
      errorName = 'Bad Request';
      this.logger.warn(`Prisma validation: ${exception.message}`);
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = 'Database is temporarily unavailable — try again shortly';
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
        !lower.includes('internal server error')
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

    // Never send Nest's default opaque copy to clients.
    if (
      typeof message === 'string' &&
      message.trim().toLowerCase() === 'internal server error'
    ) {
      message = 'Something went wrong — please try again';
    }

    const body: ErrorBody = {
      statusCode: status,
      message,
      error: errorName,
    };
    response.status(status).json(body);
  }
}
