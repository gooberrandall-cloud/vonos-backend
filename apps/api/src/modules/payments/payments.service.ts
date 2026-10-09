import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AccountTransaction, PaymentRecord } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import type { PaginatedList } from '../../common/utils/paginatedList';
import { syncSalePaymentAccountCredit } from '../../common/utils/recordPaymentAccountTxn';
import { toIso, toNumber } from '../../common/utils/serializers';
import {
  paymentTextSearchWhere,
  accountTransactionTextSearchWhere,
} from '../../common/utils/listSearch';

const BULK_LINK_MAX = 500;
const BULK_LINK_DEFAULT = 200;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly cache: CacheService,
  ) {}

  async listPayments(filters: {
    accountId?: string;
    unlinkedOnly?: boolean;
    cursor?: string;
    limit?: number;
    from?: string;
    to?: string;
    search?: string;
    includeSummary?: boolean;
  }): Promise<PaginatedList<PaymentRecord>> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      accountId: filters.accountId,
      unlinkedOnly: filters.unlinkedOnly,
      from: filters.from,
      to: filters.to,
      search: filters.search,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sum: filters.includeSummary === false ? 0 : 1,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'payments:v3',
      filterKey,
      () => this.listPaymentsUncached(filters, tenantId),
    );
  }

  private paymentListWhere(
    tenantId: string,
    filters: {
      accountId?: string;
      unlinkedOnly?: boolean;
      from?: string;
      to?: string;
      search?: string;
    },
  ) {
    return {
      tenantId,
      deletedAt: null as null,
      ...(filters.unlinkedOnly
        ? { accountId: null, saleId: { not: null }, isReturn: false }
        : filters.accountId
          ? { accountId: filters.accountId }
          : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
      ...(paymentTextSearchWhere(filters.search) ?? {}),
    };
  }

  private serializePayment(row: {
    id: string;
    tenantId: string;
    amount: { toString(): string } | number | string | null;
    currency: string;
    method: string | null;
    paymentRefNo: string | null;
    paidOn: Date | null;
    paymentFor: string | null;
    accountId: string | null;
    saleId: string | null;
    isReturn: boolean;
    note: string | null;
    createdByName: string | null;
    createdAt: Date;
    account?: { name: string } | null;
    sale?: { reference: string } | null;
    invoice?: { stockMovementId: string | null } | null;
  }): PaymentRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      amount: toNumber(row.amount),
      currency: row.currency,
      method: row.method,
      paymentRefNo: row.paymentRefNo,
      paidOn: row.paidOn ? toIso(row.paidOn) : null,
      paymentFor: row.paymentFor,
      accountId: row.accountId,
      accountName: row.account?.name ?? null,
      saleId: row.saleId,
      saleReference: row.sale?.reference ?? null,
      stockMovementId: row.invoice?.stockMovementId ?? null,
      isReturn: row.isReturn,
      note: row.note,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
    };
  }

  private async listPaymentsUncached(
    filters: {
      accountId?: string;
      unlinkedOnly?: boolean;
      cursor?: string;
      limit?: number;
      from?: string;
      to?: string;
      search?: string;
      includeSummary?: boolean;
    },
    tenantId: string,
  ): Promise<PaginatedList<PaymentRecord>> {
    const limit = filters.limit ?? 10;
    const includeSummary = filters.includeSummary !== false;
    const pagination = buildCompositeCursorQuery({
      sortField: 'createdAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit,
      sortValueType: 'date',
    });
    const baseWhere = this.paymentListWhere(tenantId, filters);

    // Summary-only (limit=1 from deferred count).
    if (includeSummary && limit <= 1 && !filters.cursor) {
      const totalCount = await this.tenantDb.db.payment.count({
        where: baseWhere,
      });
      return { items: [], totalCount, hasMore: false, pageSize: limit };
    }

    const [rows, totalCount] = await Promise.all([
      this.tenantDb.db.payment.findMany({
        where: {
          ...baseWhere,
          ...(pagination.where ?? {}),
        },
        include: {
          account: { select: { name: true } },
          sale: { select: { reference: true } },
          invoice: { select: { stockMovementId: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pagination.take,
      }),
      includeSummary
        ? this.tenantDb.db.payment.count({ where: baseWhere })
        : Promise.resolve(undefined as number | undefined),
    ]);

    const items = rows.map((row) => this.serializePayment(row));
    if (!includeSummary || totalCount == null) {
      return {
        items,
        hasMore: items.length >= limit,
        pageSize: limit,
      };
    }
    return {
      items,
      totalCount,
      hasMore: items.length >= limit,
      pageSize: limit,
    };
  }

  /**
   * Assign a payment account to unlinked sale payments and post sale_payment
   * credits. Pass paymentIds for a selection, or allUnlinked to process the
   * next batch (default 200, max 500). Call again while remaining > 0.
   */
  async bulkLinkToAccount(body: {
    accountId: string;
    paymentIds?: string[];
    allUnlinked?: boolean;
    limit?: number;
  }): Promise<{
    linked: number;
    skipped: number;
    remaining: number;
    accountId: string;
    accountName: string;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const accountId = body.accountId?.trim() || '';
    if (!accountId) {
      throw new BadRequestException('Select a Payment Account');
    }

    const account = await this.tenantDb.db.paymentAccount.findFirst({
      where: { id: accountId, tenantId, deletedAt: null },
      select: { id: true, name: true, isClosed: true },
    });
    if (!account) {
      throw new NotFoundException('Payment account not found');
    }
    if (account.isClosed) {
      throw new BadRequestException('Cannot link payments to a closed account');
    }

    const ids = (body.paymentIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean);
    const batchLimit = Math.min(
      Math.max(Number(body.limit) || BULK_LINK_DEFAULT, 1),
      BULK_LINK_MAX,
    );

    if (!body.allUnlinked && ids.length === 0) {
      throw new BadRequestException(
        'Pass paymentIds or set allUnlinked to link a batch',
      );
    }

    const unlinkedWhere = {
      tenantId,
      deletedAt: null,
      isReturn: false,
      accountId: null as string | null,
      saleId: { not: null as string | null },
    };

    const targets = body.allUnlinked
      ? await this.tenantDb.db.payment.findMany({
          where: unlinkedWhere,
          select: {
            id: true,
            amount: true,
            paidOn: true,
            createdAt: true,
            paymentRefNo: true,
            note: true,
            method: true,
            saleId: true,
            createdByName: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: batchLimit,
        })
      : await this.tenantDb.db.payment.findMany({
          where: {
            ...unlinkedWhere,
            id: { in: ids },
          },
          select: {
            id: true,
            amount: true,
            paidOn: true,
            createdAt: true,
            paymentRefNo: true,
            note: true,
            method: true,
            saleId: true,
            createdByName: true,
          },
        });

    let linked = 0;
    for (const payment of targets) {
      if (!payment.saleId) continue;
      await this.tenantDb.db.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { accountId: account.id },
        });
        await syncSalePaymentAccountCredit(tx, {
          tenantId,
          paymentId: payment.id,
          accountId: account.id,
          amount: toNumber(payment.amount),
          operationDate: payment.paidOn ?? payment.createdAt,
          refNo: payment.paymentRefNo,
          note: payment.note ?? 'Sale payment',
          paymentMethod: payment.method,
          saleId: payment.saleId,
          createdByName: payment.createdByName,
        });
      });
      linked += 1;
    }

    const remaining = await this.tenantDb.db.payment.count({
      where: unlinkedWhere,
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);

    return {
      linked,
      skipped: Math.max(0, (body.allUnlinked ? targets.length : ids.length) - linked),
      remaining,
      accountId: account.id,
      accountName: account.name,
    };
  }

  async listAccountBook(
    accountId: string,
    filters: {
      cursor?: string;
      limit?: number;
      from?: string;
      to?: string;
      search?: string;
      type?: string;
    } = {},
  ): Promise<AccountTransaction[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      accountId,
      from: filters.from,
      to: filters.to,
      search: filters.search,
      type: filters.type,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'payment-account-book',
      filterKey,
      () => this.listAccountBookUncached(accountId, filters, tenantId),
    );
  }

  private async listAccountBookUncached(
    accountId: string,
    filters: {
      cursor?: string;
      limit?: number;
      from?: string;
      to?: string;
      search?: string;
      type?: string;
    },
    tenantId: string,
  ): Promise<AccountTransaction[]> {
    const account = await this.tenantDb.db.paymentAccount.findFirst({
      where: { id: accountId, tenantId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('Payment account not found');

    const limit = filters.limit ?? 10;
    const pagination = buildCompositeCursorQuery({
      sortField: 'operationDate',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit,
      sortValueType: 'date',
    });

    const rows = await this.tenantDb.db.accountTransaction.findMany({
      where: {
        accountId,
        tenantId,
        deletedAt: null,
        ...(filters.type
          ? { type: filters.type as 'debit' | 'credit' }
          : {}),
        ...(filters.from || filters.to
          ? {
              operationDate: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
        ...(accountTransactionTextSearchWhere(filters.search) ?? {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ operationDate: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });

    if (rows.length === 0) return [];

    const oldest = rows[rows.length - 1]!;
    const priorRows = await this.tenantDb.db.$queryRaw<
      Array<{ balance: unknown }>
    >`
      SELECT COALESCE(SUM(
        CASE WHEN type = 'credit' THEN amount ELSE -amount END
      ), 0) AS balance
      FROM "AccountTransaction"
      WHERE "accountId" = ${accountId}
        AND "tenantId" = ${tenantId}
        AND "deletedAt" IS NULL
        AND (
          "operationDate" < ${oldest.operationDate}
          OR ("operationDate" = ${oldest.operationDate} AND id < ${oldest.id})
        )
    `;
    let running = toNumber(priorRows[0]?.balance ?? 0);

    const chronological = [...rows].reverse();
    const balances = new Map<string, number>();
    for (const row of chronological) {
      const amount = toNumber(row.amount);
      running = row.type === 'credit' ? running + amount : running - amount;
      balances.set(row.id, running);
    }

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      accountId: row.accountId,
      accountName: account.name,
      type: row.type,
      subType: row.subType,
      amount: toNumber(row.amount),
      refNo: row.refNo,
      operationDate: toIso(row.operationDate),
      note: row.note,
      paymentMethod: row.paymentMethod,
      paymentDetails: row.paymentDetails,
      saleId: row.saleId,
      paymentId: row.paymentId,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
      ...(balances.has(row.id) ? { accountBalance: balances.get(row.id) } : {}),
    }));
  }
}
