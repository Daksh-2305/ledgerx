import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiClient, ApiError } from './services/api/client.js';
import { PaymentTimelineBuilder } from './components/timeline.js';
import {
  formatCurrency,
  formatDate,
  getStatusBadgeClass,
  renderEmptyState,
  renderErrorState,
  renderLoadingState,
} from './components/ui-helpers.js';
import { DashboardPage } from './pages/dashboard.page.js';
import { PaymentsPage } from './pages/payments.page.js';
import { PaymentDetailPage } from './pages/payment-detail.page.js';
import { SettlementsPage } from './pages/settlements.page.js';
import { ReconciliationPage } from './pages/reconciliation.page.js';
import { SystemHealthPage } from './pages/system.page.js';
import {
  PaymentItem,
  SettlementBatchItem,
  ReconciliationRunItem,
  SystemHealthData,
  DashboardMetrics,
} from './types/index.js';

describe('Milestone 11 — Production Engineering Dashboard Frontend', () => {
  let mockFetch: any;
  let client: ApiClient;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    client = new ApiClient({ baseUrl: 'http://localhost:3000' });
  });

  describe('1. API Client & Error Handling (Section 34, 35, 36)', () => {
    it('handles 429 Too Many Requests with user-friendly message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ message: 'Rate limit exceeded' }),
      });

      await expect(client.getPayments()).rejects.toThrow(
        'Too many requests. Please try again shortly.'
      );
    });

    it('handles 403 Forbidden with security message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ message: 'Access denied' }),
      });

      await expect(client.getDeadLetterQueue()).rejects.toThrow(
        'Forbidden: You do not have permissions to perform this financial operation.'
      );
    });

    it('attaches x-admin-key header for privileged DLQ operations', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [], pagination: { total: 0 } }),
      });

      client.setAdminApiKey('test_admin_key_12345');
      await client.getDeadLetterQueue();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers['x-admin-key']).toBe('test_admin_key_12345');
    });

    it('handles network failure gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));

      await expect(client.getDashboardMetrics()).rejects.toThrow(
        'Failed to fetch'
      );
    });
  });

  describe('2. Payment Lifecycle Timeline (Section 21)', () => {
    it('generates complete progressive timeline for captured payment', () => {
      const payment: PaymentItem = {
        id: 'pay-001',
        merchantId: 'merch-001',
        customerId: 'cust-001',
        amountMinor: 100000,
        currency: 'INR',
        status: 'CAPTURED',
        capturedAmountMinor: 100000,
        refundedAmountMinor: 0,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:05:00.000Z',
      };

      const timeline = PaymentTimelineBuilder.buildTimeline(payment, [
        { status: 'AUTHORIZED', timestamp: '2026-09-01T10:02:00.000Z' },
        { status: 'CAPTURED', timestamp: '2026-09-01T10:05:00.000Z' },
      ]);

      expect(timeline.length).toBe(5);
      expect(timeline[0].step).toBe('Created');
      expect(timeline[0].status).toBe('completed');
      expect(timeline[0].timestamp).toBe('2026-09-01T10:00:00.000Z');

      expect(timeline[3].step).toBe('Captured');
      expect(timeline[3].status).toBe('current');
      expect(timeline[3].timestamp).toBe('2026-09-01T10:05:00.000Z');

      expect(timeline[4].step).toBe('Settled');
      expect(timeline[4].status).toBe('upcoming');
    });

    it('generates failed timeline accurately without inventing fake timestamps', () => {
      const payment: PaymentItem = {
        id: 'pay-fail',
        merchantId: 'merch-001',
        customerId: 'cust-001',
        amountMinor: 50000,
        currency: 'INR',
        status: 'FAILED',
        capturedAmountMinor: 0,
        refundedAmountMinor: 0,
        createdAt: '2026-09-05T12:00:00.000Z',
        updatedAt: '2026-09-05T12:01:00.000Z',
      };

      const timeline = PaymentTimelineBuilder.buildTimeline(payment);
      expect(timeline.length).toBe(3);
      expect(timeline[0].step).toBe('Created');
      expect(timeline[1].step).toBe('Pending');
      expect(timeline[2].step).toBe('Failed');
      expect(timeline[2].status).toBe('failed');
      expect(timeline[2].timestamp).toBe('2026-09-05T12:01:00.000Z');
    });
  });

  describe('3. Main Dashboard Rendering (Section 18)', () => {
    it('renders real KPI values, formatting, and status breakdown', () => {
      const metrics: DashboardMetrics = {
        totalPaymentVolumeMinor: 50000000,
        totalPaymentVolumeFormatted: '₹500,000.00 INR',
        successfulPayments: 120,
        failedPayments: 3,
        pendingPayments: 5,
        refundVolumeMinor: 1000000,
        refundVolumeFormatted: '₹10,000.00 INR',
        openReconciliationIssues: 2,
        settlementAmountMinor: 48000000,
        settlementAmountFormatted: '₹480,000.00 INR',
        webhookFailures: 1,
        highRiskPayments: 4,
        totalPayments: 128,
        statusDistribution: {
          CAPTURED: 100,
          SETTLED: 20,
          FAILED: 3,
          PENDING: 5,
        },
        volumeTrend: [
          { amount: 50000, status: 'CAPTURED', createdAt: '2026-09-20T10:00:00Z' },
        ],
      };

      const html = DashboardPage.render(metrics);
      expect(html).toContain('₹500,000.00 INR');
      expect(html).toContain('120');
      expect(html).toContain('₹10,000.00 INR');
      expect(html).toContain('₹480,000.00 INR');
      expect(html).toContain('Open Reconciliation Issues');
      expect(html).toContain('High-Risk Payments');
    });

    it('renders loading and error states cleanly', () => {
      const loadingHtml = DashboardPage.render(null, true);
      expect(loadingHtml).toContain('Loading dashboard metrics');

      const errorHtml = DashboardPage.render(null, false, 'Database down');
      expect(errorHtml).toContain('Database down');
    });
  });

  describe('4. Payments Page & Payment Details (Section 19 & 20)', () => {
    it('renders payment table with formatted currency and status badges', () => {
      const payments: PaymentItem[] = [
        {
          id: 'pay-test-1',
          merchantId: 'm-1',
          customerId: 'c-1',
          amountMinor: 250000,
          currency: 'INR',
          status: 'CAPTURED',
          capturedAmountMinor: 250000,
          refundedAmountMinor: 0,
          createdAt: '2026-09-15T10:00:00Z',
          updatedAt: '2026-09-15T10:00:00Z',
        },
      ];

      const html = PaymentsPage.render(payments, 1);
      expect(html).toContain('pay-test-1');
      expect(html).toContain('₹2,500.00 INR');
      expect(html).toContain('badge-success');
    });

    it('renders complete payment story (timeline, risk, ledger, refunds, webhooks)', () => {
      const html = PaymentDetailPage.render({
        payment: {
          id: 'pay-story-1',
          merchantId: 'merch-story',
          customerId: 'cust-story',
          amountMinor: 100000,
          currency: 'INR',
          status: 'CAPTURED',
          capturedAmountMinor: 100000,
          refundedAmountMinor: 20000,
          createdAt: '2026-09-10T10:00:00Z',
          updatedAt: '2026-09-10T10:15:00Z',
        },
        refunds: [
          {
            id: 'ref-1',
            paymentId: 'pay-story-1',
            merchantId: 'merch-story',
            amountMinor: 20000,
            currency: 'INR',
            status: 'COMPLETED',
            reason: 'Customer requested',
            createdAt: '2026-09-10T10:15:00Z',
          },
        ],
        risk: {
          id: 'risk-1',
          paymentId: 'pay-story-1',
          riskScore: 15,
          riskLevel: 'LOW',
          decision: 'ALLOW',
          triggeredRules: [],
          modelVersion: '1.0.0-rules',
          createdAt: '2026-09-10T10:00:00Z',
        },
        ledgerTransactions: [
          {
            id: 'tx-1',
            referenceId: 'pay-story-1',
            referenceType: 'PAYMENT',
            transactionType: 'CAPTURE',
            currency: 'INR',
            postedAt: '2026-09-10T10:05:00Z',
            entries: [
              {
                id: 'e-1',
                accountId: 'acc-1',
                accountCode: 'MERCHANT_SETTLEMENT_RECEIVABLE',
                entryType: 'DEBIT',
                amountMinor: 100000,
                currency: 'INR',
              },
              {
                id: 'e-2',
                accountId: 'acc-2',
                accountCode: 'PAYMENT_CLEARING',
                entryType: 'CREDIT',
                amountMinor: 100000,
                currency: 'INR',
              },
            ],
          },
        ],
        webhooks: [
          {
            id: 'wh-1',
            eventId: 'evt-wh-1',
            provider: 'mockpay',
            eventType: 'payment.captured',
            status: 'PROCESSED',
            attempts: 1,
            maxAttempts: 5,
            receivedAt: '2026-09-10T10:05:00Z',
          },
        ],
      });

      expect(html).toContain('pay-story-1');
      expect(html).toContain('Payment Lifecycle Timeline');
      expect(html).toContain('Risk Assessment Engine');
      expect(html).toContain('Double-Entry Ledger Postings');
      expect(html).toContain('Refund Operations');
      expect(html).toContain('Webhook Events & Delivery History');
      expect(html).toContain('MERCHANT_SETTLEMENT_RECEIVABLE');
      expect(html).toContain('ref-1');
      expect(html).toContain('evt-wh-1');
    });
  });

  describe('5. Settlements View & Mathematical Calculation (Section 29 & 30)', () => {
    it('renders settlement batch list with real figures', () => {
      const batches: SettlementBatchItem[] = [
        {
          id: 'batch-01',
          batchReference: 'SETTLE-ACME-001',
          merchantId: 'm-acme',
          currency: 'INR',
          periodStart: '2026-09-01T00:00:00Z',
          periodEnd: '2026-09-30T23:59:59Z',
          grossAmountMinor: 10000000,
          refundAmountMinor: 1000000,
          adjustmentAmountMinor: 100000,
          feeAmountMinor: 200000,
          netAmountMinor: 8900000,
          grossFormatted: '₹100,000.00 INR',
          refundFormatted: '₹10,000.00 INR',
          feeFormatted: '₹2,000.00 INR',
          adjustmentFormatted: '₹1,000.00 INR',
          netFormatted: '₹89,000.00 INR',
          status: 'READY',
          recordCount: 15,
          createdAt: '2026-09-30T00:00:00Z',
        },
      ];

      const html = SettlementsPage.renderList(batches, 1);
      expect(html).toContain('SETTLE-ACME-001');
      expect(html).toContain('₹89,000.00 INR');
      expect(html).toContain('READY');
    });

    it('renders settlement details with explicit mathematical breakdown', () => {
      const batch: SettlementBatchItem = {
        id: 'batch-01',
        batchReference: 'SETTLE-ACME-001',
        merchantId: 'm-acme',
        currency: 'INR',
        periodStart: '2026-09-01T00:00:00Z',
        periodEnd: '2026-09-30T23:59:59Z',
        grossAmountMinor: 10000000,
        refundAmountMinor: 1000000,
        adjustmentAmountMinor: 100000,
        feeAmountMinor: 200000,
        netAmountMinor: 8900000,
        grossFormatted: '₹100,000.00 INR',
        refundFormatted: '₹10,000.00 INR',
        feeFormatted: '₹2,000.00 INR',
        adjustmentFormatted: '₹1,000.00 INR',
        netFormatted: '₹89,000.00 INR',
        status: 'READY',
        recordCount: 1,
        createdAt: '2026-09-30T00:00:00Z',
      };

      const records = [
        {
          id: 'rec-1',
          batchId: 'batch-01',
          paymentId: 'pay-001',
          merchantId: 'm-acme',
          currency: 'INR',
          grossAmountMinor: 10000000,
          refundAmountMinor: 1000000,
          feeAmountMinor: 200000,
          netAmountMinor: 8900000,
          grossFormatted: '₹100,000.00 INR',
          refundFormatted: '₹10,000.00 INR',
          feeFormatted: '₹2,000.00 INR',
          netFormatted: '₹89,000.00 INR',
          status: 'INCLUDED' as const,
          createdAt: '2026-09-30T00:00:00Z',
        },
      ];

      const html = SettlementsPage.renderDetail(batch, records);
      expect(html).toContain('Authoritative Financial Calculation');
      expect(html).toContain('Gross Captured Payments:');
      expect(html).toContain('- Refunds (Compensating):');
      expect(html).toContain('- Platform MDR Fees (2.00%):');
      expect(html).toContain('= Net Settlement Amount:');
      expect(html).toContain('₹89,000.00 INR');
      expect(html).toContain('Execute Payout & Post Ledger');
    });
  });

  describe('6. Reconciliation Dashboard (Section 27 & 28)', () => {
    it('renders reconciliation runs and summary metrics', () => {
      const runs: ReconciliationRunItem[] = [
        {
          id: 'run-01',
          runReference: 'RECON-MOCKPAY-001',
          provider: 'mockpay',
          periodStart: '2026-09-01T00:00:00Z',
          periodEnd: '2026-09-30T23:59:59Z',
          status: 'COMPLETED',
          totalInternalRecords: 100,
          totalExternalRecords: 100,
          matchedCount: 98,
          mismatchCount: 2,
          missingInternalCount: 0,
          missingExternalCount: 0,
          duplicateCount: 0,
          createdAt: '2026-09-30T00:00:00Z',
        },
      ];

      const html = ReconciliationPage.renderRuns(runs);
      expect(html).toContain('RECON-MOCKPAY-001');
      expect(html).toContain('98');
      expect(html).toContain('2');
    });

    it('renders run details with discrepancy investigation and resolution options', () => {
      const run: ReconciliationRunItem = {
        id: 'run-01',
        runReference: 'RECON-MOCKPAY-001',
        provider: 'mockpay',
        periodStart: '2026-09-01T00:00:00Z',
        periodEnd: '2026-09-30T23:59:59Z',
        status: 'COMPLETED',
        totalInternalRecords: 10,
        totalExternalRecords: 10,
        matchedCount: 9,
        mismatchCount: 1,
        missingInternalCount: 0,
        missingExternalCount: 0,
        duplicateCount: 0,
        createdAt: '2026-09-30T00:00:00Z',
      };

      const records = [
        {
          id: 'disc-01',
          runId: 'run-01',
          internalReference: 'REF-INT-001',
          externalReference: 'REF-EXT-001',
          result: 'AMOUNT_MISMATCH' as const,
          differenceMinor: 500,
          reason: 'Internal: ₹100.00, External: ₹95.00',
          status: 'OPEN' as const,
        },
      ];

      const html = ReconciliationPage.renderRunDetail(run, records);
      expect(html).toContain('AMOUNT_MISMATCH');
      expect(html).toContain('REF-INT-001');
      expect(html).toContain('Resolve');
      expect(html).toContain('Waive');
    });
  });

  describe('7. System Infrastructure Health (Section 31)', () => {
    it('renders status of PostgreSQL, Redis, Kafka, and uptime', () => {
      const health: SystemHealthData = {
        status: 'UP',
        uptimeSeconds: 3600,
        dependencies: {
          database: { status: 'UP', connected: true, latencyMs: 2 },
          redis: { status: 'UP', connected: true, latencyMs: 1 },
          kafka: { status: 'UP', connected: true, latencyMs: 3 },
        },
        metrics: {
          redis: { memoryUsed: '1.2MB' },
          kafka: { activeBrokers: 1 },
        },
      };

      const html = SystemHealthPage.render(health);
      expect(html).toContain('PostgreSQL Database');
      expect(html).toContain('Redis Cache & Locks');
      expect(html).toContain('Kafka Event Broker');
      expect(html).toContain('60 min');
      expect(html).toContain('Healthy');
    });
  });

  describe('8. UI Helpers & Formatters (Section 33 & 39)', () => {
    it('formats currencies in minor units accurately', () => {
      expect(formatCurrency(10000, 'INR')).toBe('₹100.00 INR');
      expect(formatCurrency(500000, 'USD')).toBe('$5,000.00 USD');
    });

    it('returns appropriate badge classes for statuses', () => {
      expect(getStatusBadgeClass('CAPTURED')).toBe('badge-success');
      expect(getStatusBadgeClass('PENDING')).toBe('badge-warning');
      expect(getStatusBadgeClass('FAILED')).toBe('badge-danger');
      expect(getStatusBadgeClass('REFUNDED')).toBe('badge-info');
    });

    it('renders empty, loading, and error states', () => {
      expect(renderEmptyState('No items')).toContain('No items');
      expect(renderLoadingState('Loading data')).toContain('Loading data');
      expect(renderErrorState('Network down', 'retryFunc')).toContain('Network down');
    });
  });
});
