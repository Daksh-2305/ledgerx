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
} from '../../types/index.js';

export interface ApiErrorResponse {
  status: number;
  message: string;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(error: ApiErrorResponse) {
    super(error.message);
    this.name = 'ApiError';
    this.status = error.status;
    this.code = error.code;
    this.details = error.details;
  }
}

export class ApiClient {
  private baseUrl: string;
  private adminApiKey: string;

  constructor(options: { baseUrl?: string; adminApiKey?: string } = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.adminApiKey =
      options.adminApiKey ?? 'ledgerx_admin_secret_key_change_in_production';
  }

  public setAdminApiKey(key: string): void {
    this.adminApiKey = key;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit & { requiresAdmin?: boolean } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (options.requiresAdmin) {
      headers['x-admin-key'] = this.adminApiKey;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        let errorData: any = {};
        try {
          errorData = await response.json();
        } catch {
          errorData = { message: response.statusText };
        }

        const message = this.mapStatusToMessage(response.status, errorData.message || errorData.error);
        throw new ApiError({
          status: response.status,
          message,
          code: errorData.code,
          details: errorData.details,
        });
      }

      const json = await response.json();
      return json as T;
    } catch (err: any) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError({
        status: 0,
        message: err.message || 'Network connection failed. Please check your backend connection.',
      });
    }
  }

  private mapStatusToMessage(status: number, serverMsg?: string): string {
    switch (status) {
      case 400:
        return serverMsg || 'Bad Request: The submitted parameters are invalid.';
      case 401:
        return 'Unauthorized: Authentication required.';
      case 403:
        return 'Forbidden: You do not have permissions to perform this financial operation.';
      case 404:
        return serverMsg || 'Not Found: The requested resource was not found.';
      case 409:
        return serverMsg || 'Conflict: Concurrent update or idempotent operation already exists.';
      case 429:
        return 'Too many requests. Please try again shortly.';
      case 500:
        return serverMsg || 'Internal Server Error: Financial infrastructure encountered an error.';
      case 503:
        return 'Service Unavailable: Database or event infrastructure is degraded.';
      default:
        return serverMsg || `HTTP Error ${status}`;
    }
  }

  // Dashboard Metrics
  public async getDashboardMetrics(): Promise<{ data: DashboardMetrics }> {
    return this.request('/api/v1/dashboard/metrics');
  }

  // Payments
  public async getPayments(params: Record<string, string | number> = {}): Promise<{
    data: PaymentItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const qs = new URLSearchParams(params as any).toString();
    return this.request(`/api/v1/payments${qs ? '?' + qs : ''}`);
  }

  public async getPaymentById(id: string): Promise<{ data: PaymentItem }> {
    return this.request(`/api/v1/payments/${id}`);
  }

  public async getPaymentRefunds(paymentId: string): Promise<{ data: RefundItem[] }> {
    return this.request(`/api/v1/payments/${paymentId}/refunds`);
  }

  // Refunds
  public async getRefunds(params: Record<string, string | number> = {}): Promise<{
    data: RefundItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const qs = new URLSearchParams(params as any).toString();
    return this.request(`/api/v1/refunds${qs ? '?' + qs : ''}`);
  }

  // Ledger
  public async getLedgerAccounts(): Promise<{ data: LedgerAccountItem[] }> {
    return this.request('/api/v1/ledger/accounts');
  }

  public async getLedgerTransactions(params: Record<string, string | number> = {}): Promise<{
    data: LedgerTransactionItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const qs = new URLSearchParams(params as any).toString();
    return this.request(`/api/v1/ledger/transactions${qs ? '?' + qs : ''}`);
  }

  // Risk Engine
  public async getRiskAssessments(params: Record<string, string | number> = {}): Promise<{
    data: RiskAssessmentItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const qs = new URLSearchParams(params as any).toString();
    return this.request(`/api/v1/risk/assessments${qs ? '?' + qs : ''}`);
  }

  public async getRiskByPayment(paymentId: string): Promise<{ data: RiskAssessmentItem }> {
    return this.request(`/api/v1/risk/payments/${paymentId}`);
  }

  // Webhooks & DLQ
  public async getWebhooks(params: Record<string, string | number> = {}): Promise<{
    data: WebhookEventItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const qs = new URLSearchParams(params as any).toString();
    return this.request(`/api/v1/webhooks${qs ? '?' + qs : ''}`);
  }

  public async getDeadLetterQueue(params: Record<string, string | number> = {}): Promise<{
    data: DeadLetterItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const qs = new URLSearchParams(params as any).toString();
    return this.request(`/api/v1/webhooks/dead-letter${qs ? '?' + qs : ''}`, {
      requiresAdmin: true,
    });
  }

  public async retryDeadLetter(id: string): Promise<{ message: string }> {
    return this.request(`/api/v1/webhooks/dead-letter/${id}/retry`, {
      method: 'POST',
      requiresAdmin: true,
    });
  }

  public async resolveDeadLetter(id: string, notes?: string): Promise<{ message: string }> {
    return this.request(`/api/v1/webhooks/dead-letter/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ notes }),
      requiresAdmin: true,
    });
  }

  // Reconciliation
  public async getReconciliationRuns(params: Record<string, string | number> = {}): Promise<{
    data: ReconciliationRunItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const qs = new URLSearchParams(params as any).toString();
    return this.request(`/api/v1/reconciliation/runs${qs ? '?' + qs : ''}`);
  }

  public async getReconciliationRunById(id: string): Promise<{ data: ReconciliationRunItem }> {
    return this.request(`/api/v1/reconciliation/runs/${id}`);
  }

  public async getReconciliationRecords(
    runId: string,
    params: Record<string, string | number> = {}
  ): Promise<{
    data: ReconciliationRecordItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const qs = new URLSearchParams(params as any).toString();
    return this.request(`/api/v1/reconciliation/runs/${runId}/records${qs ? '?' + qs : ''}`);
  }

  public async triggerReconciliation(payload: {
    provider?: string;
    periodStart?: string;
    periodEnd?: string;
  }): Promise<{ message: string; data: ReconciliationRunItem }> {
    return this.request('/api/v1/reconciliation/runs', {
      method: 'POST',
      body: JSON.stringify({
        provider: payload.provider || 'mockpay',
        period_start: payload.periodStart,
        period_end: payload.periodEnd,
      }),
    });
  }

  public async resolveDiscrepancy(recordId: string, notes?: string): Promise<{ message: string }> {
    return this.request(`/api/v1/reconciliation/discrepancies/${recordId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution_notes: notes }),
    });
  }

  public async waiveDiscrepancy(recordId: string, notes?: string): Promise<{ message: string }> {
    return this.request(`/api/v1/reconciliation/discrepancies/${recordId}/waive`, {
      method: 'POST',
      body: JSON.stringify({ resolution_notes: notes }),
    });
  }

  // Settlements (Milestone 10)
  public async getSettlements(params: Record<string, string | number> = {}): Promise<{
    data: SettlementBatchItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const qs = new URLSearchParams(params as any).toString();
    return this.request(`/api/v1/settlements${qs ? '?' + qs : ''}`);
  }

  public async getSettlementById(id: string): Promise<{ data: SettlementBatchItem }> {
    return this.request(`/api/v1/settlements/${id}`);
  }

  public async getSettlementRecords(
    batchId: string,
    params: Record<string, string | number> = {}
  ): Promise<{
    data: SettlementRecordItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const qs = new URLSearchParams(params as any).toString();
    return this.request(`/api/v1/settlements/${batchId}/records${qs ? '?' + qs : ''}`);
  }

  public async getSettlementReport(id: string): Promise<{ data: any }> {
    return this.request(`/api/v1/settlements/${id}/report`);
  }

  public async createSettlementBatch(input: {
    merchantId: string;
    currency: string;
    periodStart: string;
    periodEnd: string;
    feeBps?: number;
    adjustmentAmountMinor?: number;
  }): Promise<{ message: string; batch: SettlementBatchItem }> {
    return this.request('/api/v1/settlements/batches', {
      method: 'POST',
      body: JSON.stringify({
        merchant_id: input.merchantId,
        currency: input.currency,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        fee_bps: input.feeBps,
        adjustment_amount_minor: input.adjustmentAmountMinor,
      }),
    });
  }

  public async processSettlementBatch(id: string): Promise<{ message: string; data: SettlementBatchItem }> {
    return this.request(`/api/v1/settlements/${id}/process`, {
      method: 'POST',
    });
  }

  public async executeSettlement(id: string): Promise<{ message: string; data: SettlementBatchItem }> {
    return this.request(`/api/v1/settlements/${id}/settle`, {
      method: 'POST',
    });
  }

  public async cancelSettlement(id: string, reason?: string): Promise<{ message: string; data: SettlementBatchItem }> {
    return this.request(`/api/v1/settlements/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  // System Health
  public async getSystemHealth(): Promise<SystemHealthData> {
    return this.request('/ready');
  }
}

export const api = new ApiClient();
