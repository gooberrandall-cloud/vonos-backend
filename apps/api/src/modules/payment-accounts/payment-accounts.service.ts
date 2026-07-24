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
import { toIso, toNumber } from '../../common/utils/serializers';

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
  } = {}): Promise<PaymentAccount[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'string',
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
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });

    const balances = await this.balancesForAccounts(rows.map((row) => row.id));
    return Promise.all(
      rows.map((row) => this.serializeRow(row, balances.get(row.id) ?? 0)),
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
}
