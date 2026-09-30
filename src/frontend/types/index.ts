export type PaymentStatus =
  | 'CREATED'
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'FAILED'
  | 'SETTLED';

export type RefundStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RiskDecision = 'ALLOW' | 'REVIEW' | 'BLOCK';

export type ReconciliationResult =
  | 'MATCHED'
  | 'AMOUNT_MISMATCH'
  | 'STATUS_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'MISSING_INTERNAL'
  | 'MISSING_EXTERNAL'
  | 'DUPLICATE_EXTERNAL';

export type DiscrepancyStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'WAIVED';

export type SettlementBatchStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'RECONCILED'
  | 'READY'
  | 'PROCESSING_SETTLEMENT'
  | 'SETTLED'
  | 'FAILED'
  | 'CANCELLED';

export type SettlementRecordStatus = 'PENDING' | 'INCLUDED' | 'SETTLED' | 'EXCLUDED' | 'FAILED';

export interface PaymentItem {
  id: string;
  merchantId: string;
  customerId: string;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  capturedAmountMinor: number;
  refundedAmountMinor: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentLifecycleEvent {
  step: 'Created' | 'Pending' | 'Authorized' | 'Captured' | 'Settled' | 'Failed' | 'Refunded';
  timestamp?: string;
  status: 'completed' | 'current' | 'failed' | 'upcoming';
  description?: string;
}

export interface RefundItem {
  id: string;
  paymentId: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
  status: RefundStatus;
  reason?: string;
  idempotencyKey?: string;
  createdAt: string;
}

export interface LedgerAccountItem {
  id: string;
  code: string;
  name: string;
  type: string;
  currency: string;
  balanceMinor: number;
  totalDebitsMinor: number;
  totalCreditsMinor: number;
}

export interface LedgerTransactionItem {
  id: string;
  referenceId: string;
  referenceType: string;
  transactionType: string;
  currency: string;
  description?: string;
  postedAt: string;
  entries: Array<{
    id: string;
    accountId: string;
    accountCode?: string;
    entryType: 'DEBIT' | 'CREDIT';
    amountMinor: number;
    currency: string;
  }>;
}

export interface RiskAssessmentItem {
  id: string;
  paymentId: string;
  riskScore: number;
  riskLevel: RiskLevel;
  decision: RiskDecision;
  triggeredRules: Array<{
    ruleId: string;
    ruleName: string;
    score: number;
    description: string;
  }>;
  modelVersion: string;
  createdAt: string;
}

export interface WebhookEventItem {
  id: string;
  eventId: string;
  provider: string;
  eventType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  receivedAt: string;
  processedAt?: string;
}

export interface DeadLetterItem {
  id: string;
  eventId: string;
  eventType: string;
  attempts: number;
  lastError: string;
  status: string;
  createdAt: string;
}

export interface ReconciliationRunItem {
  id: string;
  runReference: string;
  provider: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  totalInternalRecords: number;
  totalExternalRecords: number;
  matchedCount: number;
  mismatchCount: number;
  missingInternalCount: number;
  missingExternalCount: number;
  duplicateCount: number;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface ReconciliationRecordItem {
  id: string;
  runId: string;
  internalReference?: string;
  externalReference?: string;
  internalTransactionId?: string;
  externalTransactionId?: string;
  result: ReconciliationResult;
  differenceMinor: number;
  reason?: string;
  status: DiscrepancyStatus;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNotes?: string;
}

export interface SettlementBatchItem {
  id: string;
  batchReference: string;
  merchantId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  grossAmountMinor: number;
  refundAmountMinor: number;
  adjustmentAmountMinor: number;
  feeAmountMinor: number;
  netAmountMinor: number;
  grossFormatted: string;
  refundFormatted: string;
  feeFormatted: string;
  adjustmentFormatted: string;
  netFormatted: string;
  status: SettlementBatchStatus;
  recordCount: number;
  ledgerTransactionId?: string;
  errorMessage?: string;
  processingStartedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface SettlementRecordItem {
  id: string;
  batchId: string;
  paymentId: string;
  merchantId: string;
  currency: string;
  grossAmountMinor: number;
  refundAmountMinor: number;
  feeAmountMinor: number;
  netAmountMinor: number;
  grossFormatted: string;
  refundFormatted: string;
  feeFormatted: string;
  netFormatted: string;
  status: SettlementRecordStatus;
  errorMessage?: string;
  createdAt: string;
}

export interface DashboardMetrics {
  totalPaymentVolumeMinor: number;
  totalPaymentVolumeFormatted: string;
  successfulPayments: number;
  failedPayments: number;
  pendingPayments: number;
  refundVolumeMinor: number;
  refundVolumeFormatted: string;
  openReconciliationIssues: number;
  settlementAmountMinor: number;
  settlementAmountFormatted: string;
  webhookFailures: number;
  highRiskPayments: number;
  totalPayments: number;
  statusDistribution: Record<string, number>;
  volumeTrend: Array<{
    amount: number;
    status: string;
    createdAt: string;
  }>;
}

export interface SystemHealthData {
  status: 'UP' | 'DEGRADED' | 'DOWN';
  uptimeSeconds: number;
  dependencies: {
    database: { status: 'UP' | 'DOWN'; connected: boolean; latencyMs?: number };
    redis: { status: 'UP' | 'DOWN'; connected: boolean; latencyMs?: number };
    kafka: { status: 'UP' | 'DOWN'; connected: boolean; latencyMs?: number };
  };
  metrics: {
    redis?: Record<string, unknown>;
    kafka?: Record<string, unknown>;
    webhooks?: Record<string, unknown>;
  };
}
