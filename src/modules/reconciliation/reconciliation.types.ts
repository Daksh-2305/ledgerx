export type ReconciliationRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL';

export type ReconciliationResult =
  | 'MATCHED'
  | 'AMOUNT_MISMATCH'
  | 'STATUS_MISMATCH'
  | 'MISSING_INTERNAL'
  | 'MISSING_EXTERNAL'
  | 'DUPLICATE_EXTERNAL'
  | 'DUPLICATE_INTERNAL'
  | 'CURRENCY_MISMATCH';

export type DiscrepancyStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'WAIVED';

export interface ExternalTransactionEntity {
  id: string;
  provider: string;
  externalTransactionId: string;
  externalReference: string;
  paymentReference?: string | null;
  transactionType: string;
  amountMinor: bigint;
  currency: string;
  status: string;
  transactionTimestamp: Date;
  settlementDate?: Date | null;
  rawData?: Record<string, unknown> | null;
  createdAt: Date;
}

export interface InternalRecordSummary {
  id: string;
  reference: string; // payment id or reference
  idempotencyKey?: string | null;
  amountMinor: bigint;
  currency: string;
  status: string;
  createdAt: Date;
}

export interface ReconciliationRunEntity {
  id: string;
  runReference: string;
  provider: string;
  periodStart: Date;
  periodEnd: Date;
  status: ReconciliationRunStatus;
  totalInternalRecords: number;
  totalExternalRecords: number;
  matchedCount: number;
  mismatchCount: number;
  missingInternalCount: number;
  missingExternalCount: number;
  duplicateCount: number;
  startedAt?: Date | null;
  completedAt?: Date | null;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReconciliationRecordEntity {
  id: string;
  runId: string;
  internalReference?: string | null;
  externalReference?: string | null;
  internalTransactionId?: string | null;
  externalTransactionId?: string | null;
  externalDbRecordId?: string | null;
  result: ReconciliationResult;
  differenceMinor: bigint;
  reason?: string | null;
  status: DiscrepancyStatus;
  resolvedBy?: string | null;
  resolvedAt?: Date | null;
  resolutionNotes?: string | null;
  internalAmountMinor?: bigint | null;
  externalAmountMinor?: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateReconciliationRunDTO {
  provider?: string;
  periodStart: string | Date;
  periodEnd: string | Date;
  correlationId?: string;
}

export interface ReconciliationSummary {
  runId: string;
  runReference: string;
  provider: string;
  status: ReconciliationRunStatus;
  periodStart: string;
  periodEnd: string;
  totalInternal: number;
  totalExternal: number;
  matched: number;
  amountMismatches: number;
  statusMismatches: number;
  currencyMismatches: number;
  missingInternal: number;
  missingExternal: number;
  duplicates: number;
  totalDiscrepancies: number;
  matchRatePercentage: number;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
}

export interface ReconciliationRecordFilter {
  runId: string;
  result?: ReconciliationResult;
  status?: DiscrepancyStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export interface ResolveDiscrepancyDTO {
  recordId: string;
  resolvedBy: string;
  resolutionNotes: string;
  action: 'INVESTIGATE' | 'RESOLVE' | 'WAIVE';
}

export interface CreateExternalRecordDTO {
  provider: string;
  externalTransactionId: string;
  externalReference: string;
  paymentReference?: string;
  transactionType?: string;
  amountMinor: bigint | number | string;
  currency: string;
  status: string;
  transactionTimestamp: string | Date;
  settlementDate?: string | Date;
  rawData?: Record<string, unknown>;
}

export interface GenerateTestDatasetOptions {
  provider?: string;
  matchedCount: number;
  amountMismatchCount: number;
  statusMismatchCount: number;
  currencyMismatchCount?: number;
  missingInternalCount: number;
  missingExternalCount: number;
  duplicateCount: number;
  currency?: string;
  baseDate?: Date;
}
