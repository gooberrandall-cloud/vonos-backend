export const ACCOUNT_TXN_TYPES = ["debit", "credit"] as const;
export type AccountTxnType = (typeof ACCOUNT_TXN_TYPES)[number];

export interface PaymentAccount {
  id: string;
  tenantId: string;
  name: string;
  accountNumber: string;
  accountType: string | null;
  accountSubType: string | null;
  accountDetails: string | null;
  note: string | null;
  isClosed: boolean;
  balance: number;
  currency: string;
  createdByUserId?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountTransaction {
  id: string;
  tenantId: string;
  accountId: string;
  accountName?: string;
  type: AccountTxnType;
  subType: string | null;
  amount: number;
  refNo: string | null;
  operationDate: string;
  note: string | null;
  paymentMethod: string | null;
  paymentDetails: string | null;
  saleId: string | null;
  paymentId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface PaymentRecord {
  id: string;
  tenantId: string;
  amount: number;
  currency: string;
  method: string | null;
  paymentRefNo: string | null;
  paidOn: string | null;
  paymentFor: string | null;
  accountId: string | null;
  accountName?: string | null;
  saleId: string | null;
  saleReference?: string | null;
  /** Present when payment is linked to a purchase invoice. */
  stockMovementId?: string | null;
  isReturn: boolean;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

/**
 * Payment ↔ ledger/document linkage audit.
 *
 * - `fully_linked`   — has a linked account transaction AND a source document.
 * - `no_document`    — money is in the account book but no sale/invoice is linked.
 * - `unlinked_ledger`— an account transaction exists with the same
 *                      account + amount + date but its `paymentId` is null
 *                      (i.e. the ledger leg was imported/created separately).
 * - `no_ledger`      — no account transaction exists or matches.
 * - `no_account`     — the payment has no payment account at all.
 */
export const PAYMENT_LINK_AUDIT_STATUSES = [
  "fully_linked",
  "no_document",
  "unlinked_ledger",
  "no_ledger",
  "no_account",
] as const;
export type PaymentLinkAuditStatus =
  (typeof PAYMENT_LINK_AUDIT_STATUSES)[number];

export interface PaymentLinkAuditRow {
  paymentId: string;
  paymentRefNo: string | null;
  paidOn: string | null;
  createdAt: string;
  amount: number;
  currency: string;
  method: string | null;
  paymentFor: string | null;
  createdByName: string | null;
  accountId: string | null;
  accountName: string | null;
  /** `sale` or the invoice kind (`purchase` / `expense` / `payroll` / …). */
  documentType: string | null;
  documentRef: string | null;
  ledgerId: string | null;
  ledgerType: AccountTxnType | null;
  ledgerRefNo: string | null;
  ledgerDate: string | null;
  /** An unlinked ledger row that appears to be the same transaction. */
  suggestedLedgerId: string | null;
  suggestedLedgerType: AccountTxnType | null;
  suggestedLedgerDate: string | null;
  status: PaymentLinkAuditStatus;
}

export interface PaymentLinkAuditResult {
  rows: PaymentLinkAuditRow[];
  summary: Record<PaymentLinkAuditStatus, number>;
  /** Ledger rows that have no payment, sale or expense behind them. */
  orphanLedgerCount: number;
  orphanLedgerTotal: number;
  currency: string;
}

export interface PaymentLinkReconcileSkip {
  paymentId: string;
  paymentRefNo: string | null;
  reason: string;
}

export interface PaymentLinkReconcileResult {
  dryRun: boolean;
  /** Ledger rows that would be/have been linked to a payment. */
  linked: number;
  /** Missing ledger legs that would be/have been created. */
  created: number;
  /** Matched a key with more than one identical candidate (attribution only). */
  ambiguous: number;
  skipped: PaymentLinkReconcileSkip[];
  linkedAmount: number;
  createdAmount: number;
  currency: string;
}

export interface CreatePaymentAccountRequest {
  name: string;
  accountNumber?: string;
  accountType?: string;
  accountSubType?: string;
  accountDetails?: string;
  note?: string;
  currency?: string;
  /** Creates an opening credit transaction when > 0. */
  openingBalance?: number;
}

export interface UpdatePaymentAccountRequest {
  name?: string;
  accountNumber?: string;
  accountType?: string | null;
  accountSubType?: string | null;
  accountDetails?: string | null;
  note?: string | null;
  currency?: string;
  isClosed?: boolean;
}

export interface PaymentAccountDepositRequest {
  amount: number;
  note?: string;
  operationDate?: string;
  paymentMethod?: string;
  refNo?: string;
  /**
   * When set, funds move from this payment account into the deposit target
   * (debit source + credit target). When omitted, external deposit credits only.
   */
  fromAccountId?: string;
}

export interface PaymentAccountTransferRequest {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  note?: string;
  operationDate?: string;
  refNo?: string;
}
