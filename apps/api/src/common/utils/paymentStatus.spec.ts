import { paymentStatusFromAmounts } from './paymentStatus';

describe('paymentStatusFromAmounts', () => {
  it('marks unpaid as due', () => {
    expect(paymentStatusFromAmounts(100, 0)).toBe('due');
  });

  it('keeps overdue when still unpaid', () => {
    expect(paymentStatusFromAmounts(100, 0, 'overdue')).toBe('overdue');
  });

  it('marks partial when some paid', () => {
    expect(paymentStatusFromAmounts(100, 40)).toBe('partial');
  });

  it('marks paid when covered', () => {
    expect(paymentStatusFromAmounts(100, 100)).toBe('paid');
    expect(paymentStatusFromAmounts(100, 100.0000001)).toBe('paid');
  });
});
