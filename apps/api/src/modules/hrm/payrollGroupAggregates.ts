import { toNumber } from '../../common/utils/serializers';

/** Shared payroll-group maths — kept pure so they are unit-testable. */

export function payrollGroupGrossTotal(
  payrolls: Array<{
    grossPay: { toString(): string };
    totalAllowance?: { toString(): string } | null;
    totalDeduction?: { toString(): string } | null;
  }>,
): number {
  return payrolls.reduce(
    (sum, p) =>
      sum +
      toNumber(p.grossPay) +
      toNumber(p.totalAllowance ?? 0) -
      toNumber(p.totalDeduction ?? 0),
    0,
  );
}

export function aggregateGroupPaymentStatus(
  payrolls: { paymentStatus: string; netPay?: unknown }[],
): 'due' | 'partial' | 'paid' {
  if (payrolls.length === 0) return 'due';
  // Rows with netPay <= 0 can never be paid (payPayrolls skips them) — count
  // them as settled so the group is not stuck on "partial" forever.
  const isSettled = (p: { paymentStatus: string; netPay?: unknown }) =>
    p.paymentStatus === 'paid' || toNumber(p.netPay ?? 0) <= 0;
  // Any money received (full or partial row payment) moves the group off "due".
  const hasPayment = payrolls.some(
    (p) => p.paymentStatus === 'paid' || p.paymentStatus === 'partial',
  );
  if (payrolls.every(isSettled)) return 'paid';
  if (!hasPayment) return 'due';
  return 'partial';
}
