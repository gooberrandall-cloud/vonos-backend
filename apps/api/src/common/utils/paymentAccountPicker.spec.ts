import {
  isJunkPaymentAccountName,
  isPickerPaymentAccountName,
} from './paymentAccountPicker';

describe('paymentAccountPicker (audit: link real banks only)', () => {
  it.each([
    'Assets',
    'Address to new bill',
    'Accounts Payable',
    'Accounts Receivable',
    'Cash express payment',
    'Cash payment received',
    'Expense',
    'Equity',
  ])('treats %s as junk', (name) => {
    expect(isJunkPaymentAccountName(name)).toBe(true);
    expect(isPickerPaymentAccountName(name)).toBe(false);
  });

  it.each([
    'Cash Expense',
    'Cash Received',
    'Discount',
    'Moniepoint',
    'Providus',
    'Fidelity Current',
  ])('keeps real till/bank %s', (name) => {
    expect(isJunkPaymentAccountName(name)).toBe(false);
    expect(isPickerPaymentAccountName(name)).toBe(true);
  });

  it('rejects blank names', () => {
    expect(isPickerPaymentAccountName('   ')).toBe(false);
  });
});
