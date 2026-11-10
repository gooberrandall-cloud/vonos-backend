import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PAYMENT_LINK_AUDIT_STATUSES,
  type AccountTransaction,
  type PaymentLinkAuditResult,
  type PaymentLinkAuditRow,
  type PaymentLinkAuditStatus,
  type PaymentLinkReconcileResult,
  type PaymentLinkReconcileSkip,
  type PaymentRecord,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import type { PaginatedList } from '../../common/utils/paginatedList';
import {
  recordPaymentAccountTxn,
  syncSalePaymentAccountCredit,
} from '../../common/utils/recordPaymentAccountTxn';
import { toIso, toNumber } from '../../common/utils/serializers';
import {
  paymentTextSearchWhere,
  accountTransactionTextSearchWhere,
} from '../../common/utils/listSearch';

const BULK_LINK_MAX = 500;
const BULK_LINK_DEFAULT = 200;

function paymentSummaryFrom(
  receipts: { _sum: { amount: { toString(): string } | null } },
  returns: { _sum: { amount: { toString(): string } | null } },
) {
  const gross = toNumber(receipts._sum.amount);
  const returned = toNumber(returns._sum.amount);
  return {
    totalAmount: gross - returned,
    totalPaid: gross,
    totalReturn: returned,
    currency: 'NGN',
  };
}

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
      deletedAt: null,
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
      const [totalCount, receiptAgg, returnAgg] = await Promise.all([
        this.tenantDb.db.payment.count({ where: baseWhere }),
        this.tenantDb.db.payment.aggregate({
          where: { ...baseWhere, isReturn: false },
          _sum: { amount: true },
        }),
        this.tenantDb.db.payment.aggregate({
          where: { ...baseWhere, isReturn: true },
          _sum: { amount: true },
        }),
      ]);
      return {
        items: [],
        totalCount,
        hasMore: false,
        pageSize: limit,
        amountSummary: paymentSummaryFrom(receiptAgg, returnAgg),
      };
    }

    const [rows, totalCount, receiptAgg, returnAgg] = await Promise.all([
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
      includeSummary
        ? this.tenantDb.db.payment.aggregate({
            where: { ...baseWhere, isReturn: false },
            _sum: { amount: true },
          })
        : Promise.resolve(undefined),
      includeSummary
        ? this.tenantDb.db.payment.aggregate({
            where: { ...baseWhere, isReturn: true },
            _sum: { amount: true },
          })
        : Promise.resolve(undefined),
    ]);

    const items = rows.map((row) => this.serializePayment(row));
    if (!includeSummary || totalCount == null) {
      return {
        items,
        hasMore: items.length >= limit,
        pageSize: limit,
        ...(receiptAgg && returnAgg
          ? { amountSummary: paymentSummaryFrom(receiptAgg, returnAgg) }
          : {}),
      };
    }
    return {
      items,
      totalCount,
      hasMore: items.length >= limit,
      pageSize: limit,
      ...(receiptAgg && returnAgg
        ? { amountSummary: paymentSummaryFrom(receiptAgg, returnAgg) }
        : {}),
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

    const ids = (body.paymentIds ?? []).map((id) => id.trim()).filter(Boolean);
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
      skipped: Math.max(
        0,
        (body.allUnlinked ? targets.length : ids.length) - linked,
      ),
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
        ...(filters.type ? { type: filters.type as 'debit' | 'credit' } : {}),
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

    const oldest = rows[rows.length - 1];
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

  /**
   * Read-only audit: for every payment, show the source document and the
   * account-book entry (if any) and classify the linkage. Also surfaces
   * ledger rows that have no payment/document behind them.
   */
  async getPaymentLinkAudit(filters: {
    from?: string;
    to?: string;
  }): Promise<PaymentLinkAuditResult> {
    const tenantId = this.tenantDb.requireTenantId();
    const window =
      filters.from || filters.to
        ? {
            ...(filters.from ? { gte: new Date(filters.from) } : {}),
            ...(filters.to ? { lte: new Date(filters.to) } : {}),
          }
        : undefined;

    const [payments, txns] = await Promise.all([
      this.tenantDb.db.payment.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(window
            ? { OR: [{ paidOn: window }, { paidOn: null, createdAt: window }] }
            : {}),
        },
        select: {
          id: true,
          amount: true,
          currency: true,
          method: true,
          paymentRefNo: true,
          paidOn: true,
          paymentFor: true,
          accountId: true,
          saleId: true,
          invoiceId: true,
          createdByName: true,
          createdAt: true,
          account: { select: { name: true } },
          sale: { select: { reference: true } },
          invoice: { select: { reference: true, kind: true } },
        },
        orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
      }),
      this.tenantDb.db.accountTransaction.findMany({
        where: { tenantId, deletedAt: null },
        select: {
          id: true,
          paymentId: true,
          saleId: true,
          expenseId: true,
          type: true,
          subType: true,
          amount: true,
          accountId: true,
          refNo: true,
          operationDate: true,
        },
      }),
    ]);

    const linkedByPayment = new Map<string, (typeof txns)[number]>();
    for (const txn of txns) {
      if (txn.paymentId && !linkedByPayment.has(txn.paymentId)) {
        linkedByPayment.set(txn.paymentId, txn);
      }
    }

    const isOrphan = (txn: (typeof txns)[number]) =>
      !txn.paymentId &&
      !txn.saleId &&
      !txn.expenseId &&
      !['opening_balance', 'transfer', 'deposit'].includes(txn.subType ?? '');
    const orphans = txns.filter(isOrphan);

    const orphanByKey = new Map<string, (typeof txns)[number]>();
    for (const txn of orphans) {
      const key = this.linkAuditKey(
        txn.accountId,
        toNumber(txn.amount),
        txn.operationDate,
      );
      if (!orphanByKey.has(key)) orphanByKey.set(key, txn);
    }

    const summary = Object.fromEntries(
      PAYMENT_LINK_AUDIT_STATUSES.map((status) => [status, 0]),
    ) as Record<PaymentLinkAuditStatus, number>;

    const rows: PaymentLinkAuditRow[] = payments.map((payment) => {
      const linked = linkedByPayment.get(payment.id) ?? null;
      const suggested =
        !linked && payment.accountId && payment.paidOn
          ? (orphanByKey.get(
              this.linkAuditKey(
                payment.accountId,
                toNumber(payment.amount),
                payment.paidOn,
              ),
            ) ?? null)
          : null;

      const documentType = payment.saleId
        ? 'sale'
        : (payment.invoice?.kind ?? null);
      const documentRef =
        payment.sale?.reference ?? payment.invoice?.reference ?? null;

      let status: PaymentLinkAuditStatus;
      if (!payment.accountId) status = 'no_account';
      else if (linked) status = documentType ? 'fully_linked' : 'no_document';
      else if (suggested) status = 'unlinked_ledger';
      else status = 'no_ledger';

      summary[status] += 1;

      return {
        paymentId: payment.id,
        paymentRefNo: payment.paymentRefNo,
        paidOn: payment.paidOn ? toIso(payment.paidOn) : null,
        createdAt: toIso(payment.createdAt),
        amount: toNumber(payment.amount),
        currency: payment.currency,
        method: payment.method,
        paymentFor: payment.paymentFor,
        createdByName: payment.createdByName,
        accountId: payment.accountId,
        accountName: payment.account?.name ?? null,
        documentType,
        documentRef,
        ledgerId: linked?.id ?? null,
        ledgerType: linked?.type ?? null,
        ledgerRefNo: linked?.refNo ?? null,
        ledgerDate: linked ? toIso(linked.operationDate) : null,
        suggestedLedgerId: suggested?.id ?? null,
        suggestedLedgerType: suggested?.type ?? null,
        suggestedLedgerDate: suggested ? toIso(suggested.operationDate) : null,
        status,
      };
    });

    const orphanLedgerTotal = orphans.reduce(
      (sum, txn) => sum + toNumber(txn.amount),
      0,
    );

    return {
      rows,
      summary,
      orphanLedgerCount: orphans.length,
      orphanLedgerTotal,
      currency: payments[0]?.currency ?? 'NGN',
    };
  }

  private linkAuditKey(accountId: string, amount: number, date: Date): string {
    return `${accountId}|${amount.toFixed(2)}|${toIso(date)}`;
  }

  /**
   * Reconcile imported/historical payments with the account book.
   *
   * - Links a ledger row to a payment when account + amount + date match
   *   exactly (1:1 per key — never guesses across different amounts).
   * - Creates the missing credit/debit leg for payments that have an account
   *   but no ledger row at all, when the direction is unambiguous.
   *
   * Idempotent: re-running links nothing again and creates nothing again.
   * Defaults to a dry run.
   */
  async reconcilePaymentLinks(body: {
    dryRun?: boolean;
  }): Promise<PaymentLinkReconcileResult> {
    const tenantId = this.tenantDb.requireTenantId();
    const dryRun = body.dryRun !== false;

    const [payments, txns] = await Promise.all([
      this.tenantDb.db.payment.findMany({
        where: { tenantId, deletedAt: null, accountId: { not: null } },
        select: {
          id: true,
          amount: true,
          currency: true,
          method: true,
          paymentRefNo: true,
          paidOn: true,
          paymentFor: true,
          accountId: true,
          saleId: true,
          invoiceId: true,
          note: true,
          createdByName: true,
          createdAt: true,
          invoice: { select: { kind: true } },
        },
      }),
      this.tenantDb.db.accountTransaction.findMany({
        where: { tenantId, deletedAt: null },
        select: {
          id: true,
          paymentId: true,
          saleId: true,
          expenseId: true,
          subType: true,
          amount: true,
          accountId: true,
          refNo: true,
          paymentMethod: true,
          operationDate: true,
        },
      }),
    ]);

    const linkedPaymentIds = new Set(
      txns.filter((t) => t.paymentId).map((t) => t.paymentId as string),
    );
    const unlinkedPayments = payments.filter(
      (p) => !linkedPaymentIds.has(p.id),
    );
    const orphans = txns.filter(
      (t) =>
        !t.paymentId &&
        !t.saleId &&
        !t.expenseId &&
        !['opening_balance', 'transfer', 'deposit'].includes(t.subType ?? ''),
    );

    const orphansByKey = new Map<string, (typeof orphans)[number][]>();
    for (const txn of orphans) {
      const key = this.linkAuditKey(
        txn.accountId,
        toNumber(txn.amount),
        txn.operationDate,
      );
      const list = orphansByKey.get(key) ?? [];
      list.push(txn);
      orphansByKey.set(key, list);
    }

    const usedTxnIds = new Set<string>();
    const linkPlan: {
      paymentId: string;
      txnId: string;
      paymentRefNo: string | null;
      method: string | null;
      amount: number;
    }[] = [];
    const createPlan: {
      payment: (typeof payments)[number];
      direction: 'credit' | 'debit';
    }[] = [];
    const skipped: PaymentLinkReconcileSkip[] = [];
    let ambiguous = 0;

    for (const payment of unlinkedPayments) {
      if (!payment.accountId) {
        skipped.push({
          paymentId: payment.id,
          paymentRefNo: payment.paymentRefNo,
          reason: 'no_account',
        });
        continue;
      }
      const key = payment.paidOn
        ? this.linkAuditKey(
            payment.accountId,
            toNumber(payment.amount),
            payment.paidOn,
          )
        : null;
      const candidates = key ? (orphansByKey.get(key) ?? []) : [];
      const match = candidates.find((txn) => !usedTxnIds.has(txn.id));
      if (match) {
        usedTxnIds.add(match.id);
        if (candidates.length > 1) ambiguous += 1;
        linkPlan.push({
          paymentId: payment.id,
          txnId: match.id,
          paymentRefNo: payment.paymentRefNo,
          method: payment.method,
          amount: toNumber(payment.amount),
        });
        continue;
      }
      const direction = this.inferPaymentDirection(payment);
      if (!direction) {
        skipped.push({
          paymentId: payment.id,
          paymentRefNo: payment.paymentRefNo,
          reason: 'direction_unknown',
        });
        continue;
      }
      createPlan.push({ payment, direction });
    }

    const linkedAmount = linkPlan.reduce((sum, item) => sum + item.amount, 0);
    const createdAmount = createPlan.reduce(
      (sum, item) => sum + toNumber(item.payment.amount),
      0,
    );

    if (!dryRun) {
      await this.tenantDb.db.$transaction(
        async (tx) => {
          for (const item of linkPlan) {
            const txn = await tx.accountTransaction.findFirst({
              where: {
                id: item.txnId,
                tenantId,
                deletedAt: null,
                paymentId: null,
              },
              select: { id: true, refNo: true, paymentMethod: true },
            });
            if (!txn) continue;
            await tx.accountTransaction.update({
              where: { id: txn.id },
              data: {
                paymentId: item.paymentId,
                ...(txn.refNo ? {} : { refNo: item.paymentRefNo }),
                ...(txn.paymentMethod ? {} : { paymentMethod: item.method }),
              },
            });
          }
          for (const item of createPlan) {
            const exists = await tx.accountTransaction.findFirst({
              where: {
                tenantId,
                paymentId: item.payment.id,
                deletedAt: null,
              },
              select: { id: true },
            });
            if (exists) continue;
            await recordPaymentAccountTxn(tx, {
              tenantId,
              accountId: item.payment.accountId as string,
              type: item.direction,
              subType: this.paymentTxnSubType(item.payment, item.direction),
              amount: toNumber(item.payment.amount),
              operationDate: item.payment.paidOn ?? item.payment.createdAt,
              refNo: item.payment.paymentRefNo,
              note: item.payment.note ?? null,
              paymentMethod: item.payment.method,
              saleId: item.payment.saleId,
              invoiceId: item.payment.invoiceId,
              paymentId: item.payment.id,
              createdByName: item.payment.createdByName,
            });
          }
        },
        { maxWait: 15_000, timeout: 120_000 },
      );
      void invalidateTenantDashboardCache(this.cache, tenantId);
    }

    return {
      dryRun,
      linked: linkPlan.length,
      created: createPlan.length,
      ambiguous,
      skipped,
      linkedAmount,
      createdAmount,
      currency: payments[0]?.currency ?? 'NGN',
    };
  }

  private inferPaymentDirection(payment: {
    saleId: string | null;
    paymentFor: string | null;
    paymentRefNo: string | null;
    invoice: { kind: string } | null;
  }): 'credit' | 'debit' | null {
    const kind = payment.invoice?.kind ?? null;
    if (kind === 'payroll' || kind === 'payroll_group') return 'debit';
    if (kind === 'purchase' || kind === 'expense') return 'debit';
    if (kind === 'sale' || kind === 'job_invoice' || kind === 'job_quote') {
      return 'credit';
    }
    if (
      payment.paymentFor === 'payroll' ||
      payment.paymentFor === 'purchase' ||
      payment.paymentFor === 'expense'
    ) {
      return 'debit';
    }
    if (
      payment.saleId ||
      payment.paymentFor === 'sale' ||
      payment.paymentFor?.startsWith('contact:') ||
      payment.paymentRefNo?.startsWith('SP')
    ) {
      return 'credit';
    }
    return null;
  }

  private paymentTxnSubType(
    payment: {
      saleId: string | null;
      paymentFor: string | null;
      invoice: { kind: string } | null;
    },
    direction: 'credit' | 'debit',
  ): string {
    if (direction === 'credit') {
      return payment.saleId ? 'sale_payment' : 'payment_receipt';
    }
    const kind = payment.invoice?.kind ?? null;
    if (
      kind === 'payroll' ||
      kind === 'payroll_group' ||
      payment.paymentFor === 'payroll'
    ) {
      return 'payroll';
    }
    if (kind === 'purchase' || payment.paymentFor === 'purchase') {
      return 'purchase_payment';
    }
    if (kind === 'expense' || payment.paymentFor === 'expense') {
      return 'expense_payment';
    }
    return 'payment';
  }
}
