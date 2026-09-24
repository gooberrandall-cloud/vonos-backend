/**
 * Payment status from money math — not a stored/migration label.
 *
 * - paid:    paid >= total (within float epsilon)
 * - partial: 0 < paid < total
 * - due:     paid ≈ 0 (or keep "overdue" if that was already stored)
 */
export function paymentStatusFromAmounts(
  total: number,
  paid: number,
  previous?: string | null,
): 'paid' | 'partial' | 'due' | 'overdue' {
  const t = Number.isFinite(total) ? total : 0;
  const p = Number.isFinite(paid) ? Math.max(0, paid) : 0;
  if (p <= 1e-6) {
    return previous === 'overdue' ? 'overdue' : 'due';
  }
  if (p + 1e-6 < t) return 'partial';
  return 'paid';
}
