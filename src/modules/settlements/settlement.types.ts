import { SettlementBatchStatus, SettlementRecordStatus } from '@prisma/client';

export { SettlementBatchStatus, SettlementRecordStatus };

export interface SettlementBatchEntity {
  id: string;
  batchReference: string;
  merchantId: string;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  grossAmountMinor: bigint;
  refundAmountMinor: bigint;
  adjustmentAmountMinor: bigint;
  feeAmountMinor: bigint;
  netAmountMinor: bigint;
  status: SettlementBatchStatus;
  recordCount: number;
  ledgerTransactionId?: string | null;
  errorMessage?: string | null;
  createdAt: Date;
  processingStartedAt?: Date | null;
  completedAt?: Date | null;
  updatedAt: Date;
}

export interface SettlementRecordEntity {
  id: string;
  batchId: string;
  paymentId: string;
  ledgerTransactionId?: string | null;
  merchantId: string;
  grossAmountMinor: bigint;
  refundAmountMinor: bigint;
  feeAmountMinor: bigint;
  netAmountMinor: bigint;
  currency: string;
  status: SettlementRecordStatus;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSettlementBatchInput {
  merchantId: string;
  currency: string;
  periodStart: Date | string;
  periodEnd: Date | string;
  feeBps?: number;
  adjustmentAmountMinor?: bigint | number;
}

export interface SettlementFilter {
  merchantId?: string;
  currency?: string;
  status?: SettlementBatchStatus;
  fromDate?: Date | string;
  toDate?: Date | string;
  page?: number;
  limit?: number;
}

export interface SettlementRecordFilter {
  batchId: string;
  status?: SettlementRecordStatus;
  page?: number;
  limit?: number;
}

export interface SettlementReportSummary {
  batchId: string;
  batchReference: string;
  merchantId: string;
  currency: string;
  period: {
    start: string;
    end: string;
  };
  amounts: {
    grossMinor: number;
    refundMinor: number;
    feeMinor: number;
    adjustmentMinor: number;
    netMinor: number;
    grossFormatted: string;
    refundFormatted: string;
    feeFormatted: string;
    adjustmentFormatted: string;
    netFormatted: string;
  };
  recordCount: number;
  status: SettlementBatchStatus;
  ledgerTransactionId?: string | null;
  processingStartedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

export interface SettlementCalculationItem {
  paymentId: string;
  merchantId: string;
  currency: string;
  capturedAmountMinor: bigint;
  refundedAmountMinor: bigint;
  feeAmountMinor: bigint;
  netAmountMinor: bigint;
  isEligible: boolean;
  exclusionReason?: string;
  ledgerTransactionId?: string | null;
}

export interface BatchCalculationResult {
  grossAmountMinor: bigint;
  refundAmountMinor: bigint;
  feeAmountMinor: bigint;
  adjustmentAmountMinor: bigint;
  netAmountMinor: bigint;
  recordCount: number;
  items: SettlementCalculationItem[];
}
