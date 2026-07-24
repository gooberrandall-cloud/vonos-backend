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
  isReturn: boolean;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface CreatePaymentAccountRequest {
  name: string;
  accountNumber?: string;
  accountType?: string;
  accountSubType?: string;
  accountDetails?: string;
  note?: string;
  currency?: string;
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
}

export interface PaymentAccountTransferRequest {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  note?: string;
  operationDate?: string;
  refNo?: string;
}
