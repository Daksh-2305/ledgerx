import { api, ApiError } from '../services/api/client.js';
import {
  DashboardMetrics,
  PaymentItem,
  RefundItem,
  LedgerAccountItem,
  LedgerTransactionItem,
  RiskAssessmentItem,
  WebhookEventItem,
  DeadLetterItem,
  ReconciliationRunItem,
  ReconciliationRecordItem,
  SettlementBatchItem,
  SettlementRecordItem,
  SystemHealthData,
} from '../types/index.js';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export class HookManager {
  public static async execute<T>(fetcher: () => Promise<T>): Promise<{
    data: T | null;
    error: string | null;
  }> {
    try {
      const data = await fetcher();
      return { data, error: null };
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : err.message || 'Operation failed';
      return { data: null, error: msg };
    }
  }
}

export async function useDashboardMetrics(): Promise<{
  data: DashboardMetrics | null;
  loading: boolean;
  error: string | null;
}> {
  const result = await HookManager.execute(() => api.getDashboardMetrics());
  return {
    data: result.data?.data || null,
    loading: false,
    error: result.error,
  };
}

export async function usePayments(params: Record<string, any> = {}): Promise<{
  payments: PaymentItem[];
  total: number;
  loading: boolean;
  error: string | null;
}> {
  const result = await HookManager.execute(() => api.getPayments(params));
  return {
    payments: result.data?.data || [],
    total: result.data?.pagination?.total || 0,
    loading: false,
    error: result.error,
  };
}

export async function usePayment(id: string): Promise<{
  payment: PaymentItem | null;
  refunds: RefundItem[];
  risk: RiskAssessmentItem | null;
  loading: boolean;
  error: string | null;
}> {
  const [payRes, refRes, riskRes] = await Promise.all([
    HookManager.execute(() => api.getPaymentById(id)),
    HookManager.execute(() => api.getPaymentRefunds(id)),
    HookManager.execute(() => api.getRiskByPayment(id)),
  ]);

  return {
    payment: payRes.data?.data || null,
    refunds: refRes.data?.data || [],
    risk: riskRes.data?.data || null,
    loading: false,
    error: payRes.error || refRes.error || null,
  };
}

export async function useRefunds(params: Record<string, any> = {}): Promise<{
  refunds: RefundItem[];
  total: number;
  loading: boolean;
  error: string | null;
}> {
  const result = await HookManager.execute(() => api.getRefunds(params));
  return {
    refunds: result.data?.data || [],
    total: result.data?.pagination?.total || 0,
    loading: false,
    error: result.error,
  };
}

export async function useLedger(params: Record<string, any> = {}): Promise<{
  accounts: LedgerAccountItem[];
  transactions: LedgerTransactionItem[];
  totalTransactions: number;
  loading: boolean;
  error: string | null;
}> {
  const [accRes, txRes] = await Promise.all([
    HookManager.execute(() => api.getLedgerAccounts()),
    HookManager.execute(() => api.getLedgerTransactions(params)),
  ]);

  return {
    accounts: accRes.data?.data || [],
    transactions: txRes.data?.data || [],
    totalTransactions: txRes.data?.pagination?.total || 0,
    loading: false,
    error: accRes.error || txRes.error || null,
  };
}

export async function useRiskAssessments(params: Record<string, any> = {}): Promise<{
  assessments: RiskAssessmentItem[];
  total: number;
  loading: boolean;
  error: string | null;
}> {
  const result = await HookManager.execute(() => api.getRiskAssessments(params));
  return {
    assessments: result.data?.data || [],
    total: result.data?.pagination?.total || 0,
    loading: false,
    error: result.error,
  };
}

export async function useWebhooks(params: Record<string, any> = {}): Promise<{
  webhooks: WebhookEventItem[];
  total: number;
  loading: boolean;
  error: string | null;
}> {
  const result = await HookManager.execute(() => api.getWebhooks(params));
  return {
    webhooks: result.data?.data || [],
    total: result.data?.pagination?.total || 0,
    loading: false,
    error: result.error,
  };
}

export async function useDeadLetterQueue(params: Record<string, any> = {}): Promise<{
  events: DeadLetterItem[];
  total: number;
  loading: boolean;
  error: string | null;
}> {
  const result = await HookManager.execute(() => api.getDeadLetterQueue(params));
  return {
    events: result.data?.data || [],
    total: result.data?.pagination?.total || 0,
    loading: false,
    error: result.error,
  };
}

export async function useReconciliationRuns(params: Record<string, any> = {}): Promise<{
  runs: ReconciliationRunItem[];
  total: number;
  loading: boolean;
  error: string | null;
}> {
  const result = await HookManager.execute(() => api.getReconciliationRuns(params));
  return {
    runs: result.data?.data || [],
    total: result.data?.pagination?.total || 0,
    loading: false,
    error: result.error,
  };
}

export async function useReconciliationRun(runId: string): Promise<{
  run: ReconciliationRunItem | null;
  records: ReconciliationRecordItem[];
  loading: boolean;
  error: string | null;
}> {
  const [runRes, recRes] = await Promise.all([
    HookManager.execute(() => api.getReconciliationRunById(runId)),
    HookManager.execute(() => api.getReconciliationRecords(runId, { limit: 100 })),
  ]);

  return {
    run: runRes.data?.data || null,
    records: recRes.data?.data || [],
    loading: false,
    error: runRes.error || recRes.error || null,
  };
}

export async function useSettlements(params: Record<string, any> = {}): Promise<{
  settlements: SettlementBatchItem[];
  total: number;
  loading: boolean;
  error: string | null;
}> {
  const result = await HookManager.execute(() => api.getSettlements(params));
  return {
    settlements: result.data?.data || [],
    total: result.data?.pagination?.total || 0,
    loading: false,
    error: result.error,
  };
}

export async function useSettlement(id: string): Promise<{
  batch: SettlementBatchItem | null;
  records: SettlementRecordItem[];
  report: any | null;
  loading: boolean;
  error: string | null;
}> {
  const [batchRes, recRes, repRes] = await Promise.all([
    HookManager.execute(() => api.getSettlementById(id)),
    HookManager.execute(() => api.getSettlementRecords(id, { limit: 100 })),
    HookManager.execute(() => api.getSettlementReport(id)),
  ]);

  return {
    batch: batchRes.data?.data || null,
    records: recRes.data?.data || [],
    report: repRes.data?.data || null,
    loading: false,
    error: batchRes.error || recRes.error || repRes.error || null,
  };
}

export async function useSystemHealth(): Promise<{
  health: SystemHealthData | null;
  loading: boolean;
  error: string | null;
}> {
  const result = await HookManager.execute(() => api.getSystemHealth());
  return {
    health: result.data || null,
    loading: false,
    error: result.error,
  };
}
