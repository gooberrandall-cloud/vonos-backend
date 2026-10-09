import type { Prisma } from '@prisma/client';

type DbClient = Prisma.TransactionClient | Prisma.DefaultPrismaClient;

export type PaymentAccountTxnInput = {
  tenantId: string;
  accountId: string;
  type: 'credit' | 'debit';
  subType: string;
  amount: number;
  operationDate: Date;
  refNo?: string | null;
  note?: string | null;
  paymentMethod?: string | null;
  saleId?: string | null;
  paymentId?: string | null;
  expenseId?: string | null;
  invoiceId?: string | null;
  createdByName?: string | null;
};

/**
 * Records a payment-account book entry. No-op when accountId is missing or
 * amount is not positive. Used so sale/purchase payments update balances the
 * same way as deposits / fund transfers.
 */
export async function recordPaymentAccountTxn(
  db: DbClient,
  input: PaymentAccountTxnInput,
): Promise<void> {
  const amount = Number(input.amount);
  if (!input.accountId || !Number.isFinite(amount) || amount <= 0) {
    return;
  }

  const account = await db.paymentAccount.findFirst({
    where: {
      id: input.accountId,
      tenantId: input.tenantId,
      deletedAt: null,
    },
    select: { id: true, isClosed: true },
  });
  if (!account || account.isClosed) {
    return;
  }

  await db.accountTransaction.create({
    data: {
      tenantId: input.tenantId,
      accountId: account.id,
      type: input.type,
      subType: input.subType,
      amount,
      refNo: input.refNo?.trim() || null,
      operationDate: input.operationDate,
      note: input.note?.trim() || null,
      paymentMethod: input.paymentMethod?.trim() || null,
      saleId: input.saleId ?? null,
      paymentId: input.paymentId ?? null,
      expenseId: input.expenseId ?? null,
      invoiceId: input.invoiceId ?? null,
      createdByName: input.createdByName ?? null,
    },
  });
}

/** Soft-deletes all open book rows tied to a Payment (sale edit/delete). */
export async function softDeletePaymentAccountTxns(
  db: DbClient,
  input: { tenantId: string; paymentId: string },
): Promise<number> {
  const result = await db.accountTransaction.updateMany({
    where: {
      tenantId: input.tenantId,
      paymentId: input.paymentId,
      deletedAt: null,
    },
    data: { deletedAt: new Date() },
  });
  return result.count;
}

/**
 * Replaces the payment-account credit for a sale payment: remove prior linked
 * rows, then create a fresh credit when accountId is set.
 */
export async function syncSalePaymentAccountCredit(
  db: DbClient,
  input: {
    tenantId: string;
    paymentId: string;
    accountId: string | null;
    amount: number;
    operationDate: Date;
    refNo?: string | null;
    note?: string | null;
    paymentMethod?: string | null;
    saleId?: string | null;
    createdByName?: string | null;
  },
): Promise<void> {
  await softDeletePaymentAccountTxns(db, {
    tenantId: input.tenantId,
    paymentId: input.paymentId,
  });
  if (!input.accountId) return;
  await recordPaymentAccountTxn(db, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    type: 'credit',
    subType: 'sale_payment',
    amount: input.amount,
    operationDate: input.operationDate,
    refNo: input.refNo,
    note: input.note,
    paymentMethod: input.paymentMethod,
    saleId: input.saleId,
    paymentId: input.paymentId,
    createdByName: input.createdByName,
  });
}

/**
 * Replaces the payment-account debit for a purchase payment: remove prior
 * linked rows, then create a fresh debit when accountId is set.
 */
export async function syncPurchasePaymentAccountDebit(
  db: DbClient,
  input: {
    tenantId: string;
    paymentId: string;
    accountId: string | null;
    amount: number;
    operationDate: Date;
    refNo?: string | null;
    note?: string | null;
    paymentMethod?: string | null;
    createdByName?: string | null;
  },
): Promise<void> {
  await softDeletePaymentAccountTxns(db, {
    tenantId: input.tenantId,
    paymentId: input.paymentId,
  });
  if (!input.accountId) return;
  await recordPaymentAccountTxn(db, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    type: 'debit',
    subType: 'purchase_payment',
    amount: input.amount,
    operationDate: input.operationDate,
    refNo: input.refNo,
    note: input.note,
    paymentMethod: input.paymentMethod,
    paymentId: input.paymentId,
    createdByName: input.createdByName,
  });
}

/** Soft-deletes open book rows tied to an Expense. */
export async function softDeleteExpenseAccountTxns(
  db: DbClient,
  input: { tenantId: string; expenseId: string },
): Promise<number> {
  const result = await db.accountTransaction.updateMany({
    where: {
      tenantId: input.tenantId,
      expenseId: input.expenseId,
      deletedAt: null,
    },
    data: { deletedAt: new Date() },
  });
  return result.count;
}

/**
 * Replaces the payment-account debit for an expense: remove prior linked
 * rows, then create a fresh debit when accountId is set and expense is paid
 * (or partial — amount > 0).
 */
export async function syncExpenseAccountDebit(
  db: DbClient,
  input: {
    tenantId: string;
    expenseId: string;
    accountId: string | null;
    amount: number;
    operationDate: Date;
    refNo?: string | null;
    note?: string | null;
    paymentMethod?: string | null;
    createdByName?: string | null;
  },
): Promise<void> {
  await softDeleteExpenseAccountTxns(db, {
    tenantId: input.tenantId,
    expenseId: input.expenseId,
  });
  if (!input.accountId) return;
  await recordPaymentAccountTxn(db, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    type: 'debit',
    subType: 'expense',
    amount: input.amount,
    operationDate: input.operationDate,
    refNo: input.refNo,
    note: input.note,
    paymentMethod: input.paymentMethod,
    expenseId: input.expenseId,
    createdByName: input.createdByName,
  });
}
