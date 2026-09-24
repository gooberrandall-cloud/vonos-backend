import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreatePaymentAccountRequest,
  PaymentAccount,
  PaymentAccountDepositRequest,
  PaymentAccountTransferRequest,
  UpdatePaymentAccountRequest,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import { toIso, toNumber } from '../../common/utils/serializers';
import { isPickerPaymentAccountName } from '../../common/utils/paymentAccountPicker';

@Injectable()
export class PaymentAccountsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly cache: CacheService,
  ) {}

  private invalidateCaches(): void {
    void invalidateTenantDashboardCache(
      this.cache,
      this.tenantDb.requireTenantId(),
    );
  }

  private async balancesForAccounts(
    accountIds: string[],
  ): Promise<Map<string, number>> {
    if (accountIds.length === 0) return new Map();
    const rows = await this.tenantDb.db.accountTransaction.groupBy({
      by: ['accountId', 'type'],
      where: { accountId: { in: accountIds }, deletedAt: null },
      _sum: { amount: true },
    });
    const balances = new Map<string, number>();
    for (const row of rows) {
      const amount = toNumber(row._sum.amount ?? 0);
      const signed = row.type === 'credit' ? amount : -amount;
      balances.set(row.accountId, (balances.get(row.accountId) ?? 0) + signed);
    }
    return balances;
  }

  private async balanceForAccount(accountId: string): Promise<number> {
    const map = await this.balancesForAccounts([accountId]);
    return map.get(accountId) ?? 0;
  }

  private async serializeRow(
    row: {
      id: string;
      tenantId: string;
      name: string;
      accountNumber: string;
      accountType: string | null;
      accountSubType: string | null;
      accountDetails: string | null;
      note: string | null;
      isClosed: boolean;
      currency: string;
      createdByUserId: string | null;
      createdByName: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    balance?: number,
  ): Promise<PaymentAccount> {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      accountNumber: row.accountNumber,
      accountType: row.accountType,
      accountSubType: row.accountSubType,
      accountDetails: row.accountDetails,
      note: row.note,
      isClosed: row.isClosed,
      balance: balance ?? (await this.balanceForAccount(row.id)),
      currency: row.currency,
      createdByUserId: row.createdByUserId,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  private async requireOpenAccount(id: string, tenantId: string) {
    const account = await this.tenantDb.db.paymentAccount.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('Payment account not found');
    if (account.isClosed) {
      throw new BadRequestException('Payment account is closed');
    }
    return account;
  }

  async list(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    /** Open cash/bank tills for payment pickers (excludes closed + chart junk). */
    openOnly?: boolean;
    /** Skip balance aggregation — pickers only need id/name. */
    lite?: boolean;
  } = {}): Promise<PaymentAccount[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      // v3: all open tills (cash + banks), not a 3-name whitelist
      openOnly: filters.openOnly ? 'picker-v3' : 0,
      lite: filters.lite ? 1 : 0,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'payment-accounts',
      filterKey,
      () => this.listUncached(filters, tenantId),
    );
  }

  private async listUncached(
    filters: {
      cursor?: string;
      limit?: number;
      search?: string;
      openOnly?: boolean;
      lite?: boolean;
    },
    tenantId: string,
  ): Promise<PaymentAccount[]> {
    // Payment pickers: all open tills (cash + banks), excluding chart junk.
    if (filters.openOnly) {
      const take = Math.min(Math.max(filters.limit ?? 40, 1), 200);
      const allOpen = await this.tenantDb.db.paymentAccount.findMany({
        where: {
          tenantId,
          deletedAt: null,
          isClosed: false,
          ...(filters.search
            ? {
                OR: [
                  {
                    name: { contains: filters.search, mode: 'insensitive' },
                  },
                  {
                    accountNumber: {
                      contains: filters.search,
                      mode: 'insensitive',
                    },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        // Over-fetch slightly so in-memory name filter still fills the page.
        take: take * 3,
      });
      const usable = allOpen
        .filter((row) => isPickerPaymentAccountName(row.name))
        .slice(0, take);
      // Pickers don't need live balances — skip the extra aggregate round-trip.
      if (filters.lite) {
        return Promise.all(usable.map((row) => this.serializeRow(row, 0)));
      }
      const balances = await this.balancesForAccounts(
        usable.map((row) => row.id),
      );
      return Promise.all(
        usable.map((row) => this.serializeRow(row, balances.get(row.id) ?? 0)),
      );
    }

    const pagination = buildCompositeCursorQuery({
      sortField: 'updatedAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.tenantDb.db.paymentAccount.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                {
                  accountNumber: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });

    const page = rows.slice(0, filters.limit ?? 10);
    const balances = await this.balancesForAccounts(page.map((row) => row.id));
    return Promise.all(
      page.map((row) => this.serializeRow(row, balances.get(row.id) ?? 0)),
    );
  }

  async getById(id: string): Promise<PaymentAccount> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.paymentAccount.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Payment account not found');
    return this.serializeRow(row);
  }

  async create(dto: CreatePaymentAccountRequest): Promise<PaymentAccount> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Account name is required');

    const userId = this.tenantDb.getAuthUserId();
    let createdByName: string | null = null;
    if (userId) {
      const user = await this.tenantDb.db.user.findFirst({
        where: { id: userId },
        select: { name: true },
      });
      createdByName = user?.name ?? null;
    }

    const openingBalance = Number(dto.openingBalance ?? 0);
    const hasOpening =
      Number.isFinite(openingBalance) && openingBalance > 0;

    const row = await this.tenantDb.db.paymentAccount.create({
      data: {
        tenantId,
        name,
        accountNumber:
          dto.accountNumber?.trim() ||
          `ACC-${Date.now().toString(36).toUpperCase()}`,
        accountType: dto.accountType?.trim() ?? null,
        accountSubType: dto.accountSubType?.trim() ?? null,
        accountDetails: dto.accountDetails?.trim() ?? null,
        note: dto.note?.trim() ?? null,
        currency: dto.currency?.trim() || 'NGN',
        createdByUserId: userId,
        createdByName,
      },
    });

    if (hasOpening) {
      await this.tenantDb.db.accountTransaction.create({
        data: {
          tenantId,
          accountId: row.id,
          type: 'credit',
          subType: 'opening_balance',
          amount: openingBalance,
          operationDate: new Date(),
          note: 'Opening balance',
          createdByName,
        },
      });
    }

    this.invalidateCaches();
    return this.serializeRow(row);
  }

  async update(
    id: string,
    dto: UpdatePaymentAccountRequest,
  ): Promise<PaymentAccount> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.paymentAccount.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Payment account not found');

    const row = await this.tenantDb.db.paymentAccount.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.accountNumber !== undefined
          ? { accountNumber: dto.accountNumber.trim() }
          : {}),
        ...(dto.accountType !== undefined
          ? { accountType: dto.accountType?.trim() ?? null }
          : {}),
        ...(dto.accountSubType !== undefined
          ? { accountSubType: dto.accountSubType?.trim() ?? null }
          : {}),
        ...(dto.accountDetails !== undefined
          ? { accountDetails: dto.accountDetails?.trim() ?? null }
          : {}),
        ...(dto.note !== undefined ? { note: dto.note?.trim() ?? null } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency.trim() } : {}),
        ...(dto.isClosed !== undefined ? { isClosed: dto.isClosed } : {}),
      },
    });
    this.invalidateCaches();
    return this.serializeRow(row);
  }

  async close(id: string): Promise<PaymentAccount> {
    return this.update(id, { isClosed: true });
  }

  async deposit(
    id: string,
    dto: PaymentAccountDepositRequest,
  ): Promise<PaymentAccount> {
    const tenantId = this.tenantDb.requireTenantId();
    const account = await this.requireOpenAccount(id, tenantId);
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Deposit amount must be greater than zero');
    }

    const fromAccountId = dto.fromAccountId?.trim();
    if (fromAccountId) {
      if (fromAccountId === account.id) {
        throw new BadRequestException(
          'Deposit from account must be a different payment account',
        );
      }
      // Move money between payment accounts (balances update on both sides).
      await this.fundTransfer({
        fromAccountId,
        toAccountId: account.id,
        amount,
        note: dto.note?.trim() || undefined,
        operationDate: dto.operationDate,
        refNo: dto.refNo?.trim() || undefined,
      });
      return this.getById(id);
    }

    const userId = this.tenantDb.getAuthUserId();
    let createdByName: string | null = null;
    if (userId) {
      const user = await this.tenantDb.db.user.findFirst({
        where: { id: userId },
        select: { name: true },
      });
      createdByName = user?.name ?? null;
    }

    await this.tenantDb.db.accountTransaction.create({
      data: {
        tenantId,
        accountId: account.id,
        type: 'credit',
        subType: 'deposit',
        amount,
        refNo: dto.refNo?.trim() ?? null,
        operationDate: dto.operationDate
          ? new Date(dto.operationDate)
          : new Date(),
        note: dto.note?.trim() ?? null,
        paymentMethod: dto.paymentMethod?.trim() ?? null,
        createdByName,
      },
    });

    this.invalidateCaches();
    return this.getById(id);
  }

  async fundTransfer(
    dto: PaymentAccountTransferRequest,
  ): Promise<{ from: PaymentAccount; to: PaymentAccount }> {
    const tenantId = this.tenantDb.requireTenantId();
    if (dto.fromAccountId === dto.toAccountId) {
      throw new BadRequestException('Cannot transfer to the same account');
    }
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Transfer amount must be greater than zero');
    }

    const from = await this.requireOpenAccount(dto.fromAccountId, tenantId);
    const to = await this.requireOpenAccount(dto.toAccountId, tenantId);
    const fromBalance = await this.balanceForAccount(from.id);
    if (fromBalance < amount) {
      throw new BadRequestException('Insufficient balance for transfer');
    }

    const userId = this.tenantDb.getAuthUserId();
    let createdByName: string | null = null;
    if (userId) {
      const user = await this.tenantDb.db.user.findFirst({
        where: { id: userId },
        select: { name: true },
      });
      createdByName = user?.name ?? null;
    }

    const operationDate = dto.operationDate
      ? new Date(dto.operationDate)
      : new Date();
    const refNo = dto.refNo?.trim() ?? `TRF-${Date.now().toString(36).toUpperCase()}`;
    const note = dto.note?.trim() ?? `Transfer to ${to.name}`;

    await this.tenantDb.db.$transaction([
      this.tenantDb.db.accountTransaction.create({
        data: {
          tenantId,
          accountId: from.id,
          type: 'debit',
          subType: 'fund_transfer',
          amount,
          refNo,
          operationDate,
          note,
          paymentDetails: `To: ${to.name}`,
          createdByName,
        },
      }),
      this.tenantDb.db.accountTransaction.create({
        data: {
          tenantId,
          accountId: to.id,
          type: 'credit',
          subType: 'fund_transfer',
          amount,
          refNo,
          operationDate,
          note: dto.note?.trim() ?? `Transfer from ${from.name}`,
          paymentDetails: `From: ${from.name}`,
          createdByName,
        },
      }),
    ]);

    this.invalidateCaches();
    return {
      from: await this.getById(from.id),
      to: await this.getById(to.id),
    };
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.paymentAccount.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Payment account not found');
    await this.tenantDb.db.paymentAccount.update({
      where: { id },
      data: { deletedAt: new Date(), isClosed: true },
    });
    this.invalidateCaches();
  }

  /** Sale/customer payments with no payment account selected. */
  async countUnlinkedPayments(): Promise<{ count: number }> {
    const tenantId = this.tenantDb.requireTenantId();
    const count = await this.tenantDb.db.payment.count({
      where: {
        tenantId,
        deletedAt: null,
        isReturn: false,
        accountId: null,
        saleId: { not: null },
      },
    });
    return { count };
  }

  /**
   * Link orphan credits to sale payments by paymentId only.
   * Does NOT create new credits — after a ledger wipe, creating would
   * re-fill accounts from historical payments and undo the clean slate.
   */
  async backfillSalePaymentCredits(): Promise<{
    linkedOrphans: number;
    createdCredits: number;
    skipped: number;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const payments = await this.tenantDb.db.payment.findMany({
      where: {
        tenantId,
        deletedAt: null,
        isReturn: false,
        accountId: { not: null },
        saleId: { not: null },
      },
      select: {
        id: true,
        amount: true,
        accountId: true,
        saleId: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    let linkedOrphans = 0;
    let createdCredits = 0;
    let skipped = 0;

    for (const payment of payments) {
      if (!payment.accountId) {
        skipped += 1;
        continue;
      }

      const existingLinked = await this.tenantDb.db.accountTransaction.findFirst({
        where: {
          tenantId,
          paymentId: payment.id,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (existingLinked) {
        skipped += 1;
        continue;
      }

      const amount = toNumber(payment.amount);
      const orphan = await this.tenantDb.db.accountTransaction.findFirst({
        where: {
          tenantId,
          accountId: payment.accountId,
          type: 'credit',
          paymentId: null,
          deletedAt: null,
          amount,
        },
        orderBy: { operationDate: 'asc' },
        select: { id: true },
      });

      if (orphan) {
        await this.tenantDb.db.accountTransaction.update({
          where: { id: orphan.id },
          data: {
            paymentId: payment.id,
            saleId: payment.saleId,
            subType: 'sale_payment',
          },
        });
        linkedOrphans += 1;
        continue;
      }

      // Intentionally do not create credits — accountant / new sales post fresh.
      skipped += 1;
    }

    this.invalidateCaches();
    return { linkedOrphans, createdCredits, skipped };
  }
}
