import { Injectable, NotFoundException } from '@nestjs/common';
import type { PaymentAccount } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { toIso, toNumber } from '../../common/utils/serializers';

@Injectable()
export class PaymentAccountsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  private async balanceForAccount(accountId: string): Promise<number> {
    const rows = await this.tenantDb.db.accountTransaction.findMany({
      where: { accountId, deletedAt: null },
      select: { type: true, amount: true },
    });
    return rows.reduce((sum, row) => {
      const amount = toNumber(row.amount);
      return row.type === 'credit' ? sum + amount : sum - amount;
    }, 0);
  }

  async list(): Promise<PaymentAccount[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.paymentAccount.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { name: 'asc' },
    });

    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        accountSubType: row.accountSubType,
        accountDetails: row.accountDetails,
        note: row.note,
        isClosed: row.isClosed,
        balance: await this.balanceForAccount(row.id),
        currency: row.currency,
        createdByUserId: row.createdByUserId,
        createdByName: row.createdByName,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    );
  }

  async getById(id: string): Promise<PaymentAccount> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.paymentAccount.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Payment account not found');
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
      balance: await this.balanceForAccount(row.id),
      currency: row.currency,
      createdByUserId: row.createdByUserId,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }
}
