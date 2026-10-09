import {
  aggregateGroupPaymentStatus,
  payrollGroupGrossTotal,
} from './payrollGroupAggregates';

describe('payrollGroupGrossTotal', () => {
  it('sums basic + earnings − deductions across the group', () => {
    const total = payrollGroupGrossTotal([
      {
        grossPay: 100_000 as any,
        totalAllowance: 10_000 as any,
        totalDeduction: 5_000 as any,
      },
      { grossPay: 50_000 as any, totalAllowance: null, totalDeduction: null },
      { grossPay: 20_000 as any, totalDeduction: 20_000 as any },
    ]);
    expect(total).toBe(155_000);
  });

  it('handles Prisma Decimal-style values', () => {
    const total = payrollGroupGrossTotal([
      {
        grossPay: { toString: () => '1234.5' },
        totalAllowance: { toString: () => '0.5' },
        totalDeduction: { toString: () => '35' },
      },
    ]);
    expect(total).toBe(1200);
  });

  it('treats a missing deduction field as zero (legacy rows)', () => {
    const total = payrollGroupGrossTotal([
      { grossPay: 100 as any, totalAllowance: 10 as any },
    ]);
    expect(total).toBe(110);
  });
});

describe('aggregateGroupPaymentStatus', () => {
  it('is due when nothing is paid', () => {
    expect(
      aggregateGroupPaymentStatus([
        { paymentStatus: 'due', netPay: 100 },
        { paymentStatus: 'due', netPay: 200 },
      ]),
    ).toBe('due');
  });

  it('is partial when only some rows are paid', () => {
    expect(
      aggregateGroupPaymentStatus([
        { paymentStatus: 'paid', netPay: 100 },
        { paymentStatus: 'due', netPay: 200 },
      ]),
    ).toBe('partial');
  });

  it('is partial as soon as any row has a partial payment', () => {
    expect(
      aggregateGroupPaymentStatus([
        { paymentStatus: 'partial', netPay: 100 },
        { paymentStatus: 'due', netPay: 200 },
      ]),
    ).toBe('partial');
  });

  it('stays partial until the entire group is settled', () => {
    expect(
      aggregateGroupPaymentStatus([
        { paymentStatus: 'paid', netPay: 100 },
        { paymentStatus: 'partial', netPay: 200 },
        { paymentStatus: 'due', netPay: 300 },
      ]),
    ).toBe('partial');
  });

  it('is paid when every row is paid', () => {
    expect(
      aggregateGroupPaymentStatus([
        { paymentStatus: 'paid', netPay: 100 },
        { paymentStatus: 'paid', netPay: 200 },
      ]),
    ).toBe('paid');
  });

  it('treats zero/negative net rows as settled so the group can complete', () => {
    expect(
      aggregateGroupPaymentStatus([
        { paymentStatus: 'paid', netPay: 100 },
        { paymentStatus: 'due', netPay: 0 },
      ]),
    ).toBe('paid');
  });

  it('is paid when every row is zero/negative net (nothing left to pay)', () => {
    expect(
      aggregateGroupPaymentStatus([
        { paymentStatus: 'due', netPay: 0 },
        { paymentStatus: 'due', netPay: -50 },
      ]),
    ).toBe('paid');
  });

  it('is due for an empty group', () => {
    expect(aggregateGroupPaymentStatus([])).toBe('due');
  });
});
