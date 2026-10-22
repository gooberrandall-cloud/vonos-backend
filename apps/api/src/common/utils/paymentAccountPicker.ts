/**
 * Chart-of-accounts imports that are not real bank/cash tills staff should
 * pick when recording a payment. Real tills (Cash Expense / Cash Received /
 * Discount / Moniepoint / Providus / Fidelity / etc.) stay selectable.
 */
const JUNK_PAYMENT_ACCOUNT_NAME_RE =
  /^(assets?|liabilit(y|ies)|equity|income|expense|address\s+to\s+new\s+bill|accounts?\s+payable|accounts?\s+receivable|cash\s+express\s+payment|cash\s+payment\s+received)\b/i;

export function isJunkPaymentAccountName(name: string): boolean {
  return JUNK_PAYMENT_ACCOUNT_NAME_RE.test(name.trim());
}

/** Open, non-junk accounts for sale/purchase/contact payment pickers. */
export function isPickerPaymentAccountName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return !isJunkPaymentAccountName(trimmed);
}
