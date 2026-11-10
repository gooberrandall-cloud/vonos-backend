import {
  recordPaymentAccountTxn,
  softDeletePaymentAccountTxns,
  syncSalePaymentAccountCredit,
} from './recordPaymentAccountTxn';

type MockDb = {
  paymentAccount: { findFirst: jest.Mock };
  accountTransaction: {
    create: jest.Mock;
    updateMany: jest.Mock;
  };
};

function makeDb(overrides?: Partial<MockDb>): MockDb {
  return {
    paymentAccount: {
      findFirst: jest.fn().mockResolvedValue({ id: 'acc_1', isClosed: false }),
    },
    accountTransaction: {
      create: jest.fn().mockResolvedValue({ id: 'txn_1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    ...overrides,
  };
}

describe('recordPaymentAccountTxn', () => {
  it('no-ops when accountId is missing', async () => {
    const db = makeDb();
    await recordPaymentAccountTxn(db as never, {
      tenantId: 't1',
      accountId: '',
      type: 'credit',
      subType: 'sale_payment',
      amount: 1000,
      operationDate: new Date('2026-07-01'),
    });
    expect(db.accountTransaction.create).not.toHaveBeenCalled();
  });

  it('no-ops when amount is not positive', async () => {
    const db = makeDb();
    await recordPaymentAccountTxn(db as never, {
      tenantId: 't1',
      accountId: 'acc_1',
      type: 'credit',
      subType: 'sale_payment',
      amount: 0,
      operationDate: new Date('2026-07-01'),
    });
    expect(db.accountTransaction.create).not.toHaveBeenCalled();
  });

  it('creates a credit when account is open', async () => {
    const db = makeDb();
    await recordPaymentAccountTxn(db as never, {
      tenantId: 't1',
      accountId: 'acc_1',
      type: 'credit',
      subType: 'sale_payment',
      amount: 15000,
      operationDate: new Date('2026-07-01'),
      paymentId: 'pay_1',
      saleId: 'sale_1',
      refNo: 'SP2026/INV1',
    });
    expect(db.accountTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 't1',
        accountId: 'acc_1',
        type: 'credit',
        subType: 'sale_payment',
        amount: 15000,
        paymentId: 'pay_1',
        saleId: 'sale_1',
      }),
    });
  });

  it('skips closed accounts', async () => {
    const db = makeDb({
      paymentAccount: {
        findFirst: jest.fn().mockResolvedValue({ id: 'acc_1', isClosed: true }),
      },
    });
    await recordPaymentAccountTxn(db as never, {
      tenantId: 't1',
      accountId: 'acc_1',
      type: 'credit',
      subType: 'sale_payment',
      amount: 100,
      operationDate: new Date('2026-07-01'),
    });
    expect(db.accountTransaction.create).not.toHaveBeenCalled();
  });
});

describe('softDeletePaymentAccountTxns', () => {
  it('soft-deletes open rows for a payment', async () => {
    const db = makeDb();
    const count = await softDeletePaymentAccountTxns(db as never, {
      tenantId: 't1',
      paymentId: 'pay_1',
    });
    expect(count).toBe(1);
    expect(db.accountTransaction.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 't1', paymentId: 'pay_1', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });
});

describe('syncSalePaymentAccountCredit', () => {
  it('soft-deletes prior rows then creates a fresh credit', async () => {
    const db = makeDb();
    await syncSalePaymentAccountCredit(db as never, {
      tenantId: 't1',
      paymentId: 'pay_1',
      accountId: 'acc_1',
      amount: 10000,
      operationDate: new Date('2026-07-02'),
      saleId: 'sale_1',
      paymentMethod: 'cash',
    });
    expect(db.accountTransaction.updateMany).toHaveBeenCalled();
    expect(db.accountTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: 'pay_1',
        accountId: 'acc_1',
        type: 'credit',
        subType: 'sale_payment',
        amount: 10000,
      }),
    });
  });

  it('soft-deletes prior rows and skips create when account cleared', async () => {
    const db = makeDb();
    await syncSalePaymentAccountCredit(db as never, {
      tenantId: 't1',
      paymentId: 'pay_1',
      accountId: null,
      amount: 10000,
      operationDate: new Date('2026-07-02'),
    });
    expect(db.accountTransaction.updateMany).toHaveBeenCalled();
    expect(db.accountTransaction.create).not.toHaveBeenCalled();
  });
});
