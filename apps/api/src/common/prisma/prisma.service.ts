import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const CONNECT_MAX_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 2_000;

const tenantScopedModels = new Set([
  'Item',
  'Job',
  'LedgerEntry',
  'Supplier',
  'StockMovement',
  'User',
  'Customer',
  'Sale',
  'Payment',
  'PaymentAccount',
  'AccountTransaction',
  'Appointment',
  'AuditLog',
  'Vehicle',
  'Requisition',
  'SalonService',
  'CafeTable',
]);

const modelsWithoutSoftDelete = new Set([
  'Notification',
  'AuditLog',
  'MigrationLegacyId',
  'AuthToken',
]);

function applySoftDeleteFilter(args: { where?: Record<string, unknown> }) {
  if (!args.where) args.where = {};
  if (args.where.deletedAt === undefined) {
    args.where.deletedAt = null;
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
      try {
        await this.$connect();
        return;
      } catch (error) {
        const isLast = attempt === CONNECT_MAX_ATTEMPTS;
        const message = error instanceof Error ? error.message : String(error);
        if (isLast) throw error;
        this.logger.warn(
          `Database connect attempt ${attempt}/${CONNECT_MAX_ATTEMPTS} failed (${message}). Retrying in ${CONNECT_RETRY_DELAY_MS}ms…`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, CONNECT_RETRY_DELAY_MS),
        );
      }
    }
  }

  forTenant(tenantId: string | null): PrismaClient {
    return this.$extends({
      query: {
        $allModels: {
          async findMany({ model, args, query }) {
            if (tenantId !== null && tenantScopedModels.has(model)) {
              args.where = { ...args.where, tenantId };
            }
            if (!modelsWithoutSoftDelete.has(model))
              applySoftDeleteFilter(args);
            return query(args);
          },
          async findFirst({ model, args, query }) {
            if (tenantId !== null && tenantScopedModels.has(model)) {
              args.where = { ...args.where, tenantId };
            }
            if (!modelsWithoutSoftDelete.has(model))
              applySoftDeleteFilter(args);
            return query(args);
          },
          async findUnique({ model, args, query }) {
            if (tenantId !== null && tenantScopedModels.has(model)) {
              args.where = { ...args.where, tenantId };
            }
            return query(args);
          },
          async create({ model, args, query }) {
            if (tenantId !== null && tenantScopedModels.has(model)) {
              args.data = { ...args.data, tenantId } as typeof args.data;
            }
            return query(args);
          },
          async update({ model, args, query }) {
            if (tenantId !== null && tenantScopedModels.has(model)) {
              args.where = { ...args.where, tenantId };
            }
            return query(args);
          },
          async count({ model, args, query }) {
            if (tenantId !== null && tenantScopedModels.has(model)) {
              args.where = { ...args.where, tenantId };
            }
            if (!modelsWithoutSoftDelete.has(model))
              applySoftDeleteFilter(args);
            return query(args);
          },
          async aggregate({ model, args, query }) {
            if (tenantId !== null && tenantScopedModels.has(model)) {
              args.where = { ...args.where, tenantId };
            }
            if (!modelsWithoutSoftDelete.has(model))
              applySoftDeleteFilter(args);
            return query(args);
          },
          async groupBy({ model, args, query }) {
            if (tenantId !== null && tenantScopedModels.has(model)) {
              args.where = { ...args.where, tenantId };
            }
            if (!modelsWithoutSoftDelete.has(model))
              applySoftDeleteFilter(args);
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
  }
}

export type TenantScopedPrisma = ReturnType<PrismaService['forTenant']>;
