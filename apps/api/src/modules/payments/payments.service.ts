import { Injectable, NotFoundException } from '@nestjs/common';
import type { AccountTransaction, PaymentRecord } from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { buildCursorQuery } from '../../common/utils/pagination';
import { toIso, toNumber } from '../../common/utils/serializers';

@Injectable()
export class PaymentsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  async listPayments(filters: {
    accountId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<PaymentRecord[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const rows = await this.tenantDb.db.payment.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.accountId ? { accountId: filters.accountId } : {}),
      },
      include: {
        account: { select: { name: true } },
        sale: { select: { reference: true } },
      },
      orderBy: { paidOn: 'desc' },
      ...buildCursorQuery(filters.cursor, filters.limit ?? 100),
    });

    return rows.map((row) => ({
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
      isReturn: row.isReturn,
      note: row.note,
      createdByName: row.createdByName,
      createdAt: toIso(row.createdAt),
    }));
  }

  async listAccountBook(accountId: string): Promise<AccountTransaction[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const account = await this.tenantDb.db.paymentAccount.findFirst({
      where: { id: accountId, tenantId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('Payment account not found');

    const rows = await this.tenantDb.db.accountTransaction.findMany({
      where: { accountId, tenantId, deletedAt: null },
      orderBy: { operationDate: 'desc' },
      take: 500,
    });

    let running = 0;
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
