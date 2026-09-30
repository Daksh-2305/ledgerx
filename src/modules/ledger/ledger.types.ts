export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE' | 'CLEARING';
export type EntryType = 'DEBIT' | 'CREDIT';
export type TransactionType = 'PAYMENT' | 'CAPTURE' | 'REFUND' | 'SETTLEMENT' | 'ADJUSTMENT';

export interface LedgerAccountEntity {
  id: string;
  merchantId?: string | null;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerEntryEntity {
  id: string;
  transactionId: string;
  accountId: string;
  entryType: EntryType;
  amountMinor: bigint;
  currency: string;
  createdAt: Date;
  accountName?: string;
  accountCode?: string;
}

export interface LedgerTransactionEntity {
  id: string;
  referenceType: string;
  referenceId?: string | null;
  transactionType: TransactionType;
  currency: string;
  description?: string | null;
  postedAt: Date;
  createdAt: Date;
}

export interface AccountBalanceSummary {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  currency: string;
  totalDebitsMinor: bigint;
  totalCreditsMinor: bigint;
  netBalanceMinor: bigint;
  entryCount: number;
}

export interface CreateLedgerEntryInput {
  accountId: string;
  entryType: EntryType;
  amountMinor: bigint | number;
  currency?: string;
}

export interface CreateLedgerTransactionInput {
  referenceType: string;
  referenceId: string;
  transactionType: TransactionType;
  currency: string;
  description?: string;
  entries: CreateLedgerEntryInput[];
  actorId?: string;
  correlationId?: string;
}

export interface LedgerTransactionFilter {
  referenceType?: string;
  referenceId?: string;
  transactionType?: TransactionType;
  currency?: string;
  fromDate?: Date;
  toDate?: Date;
  page: number;
  limit: number;
}

export interface LedgerIntegrityReport {
  healthy: boolean;
  total_transactions: number;
  balanced_transactions: number;
  unbalanced_transactions: number;
  orphan_entries: number;
  duplicate_financial_references: number;
  checked_at: string;
}
