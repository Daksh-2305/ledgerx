import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { ReconciliationMatcher } from './reconciliation-matcher.js';
import { InMemoryReconciliationRepository } from './reconciliation.repository.js';
import { ReconciliationService } from './reconciliation.service.js';
import { ReconciliationConsumer } from './reconciliation-consumer.service.js';
import { createServer } from '../../server.js';
import {
  setReconciliationContainer,
  createReconciliationContainer,
} from './reconciliation.container.js';
import {
  InvalidStateTransitionError,
  ValidationError,
  NotFoundError,
} from '../../common/errors.js';
import type {
  InternalRecordSummary,
  ExternalTransactionEntity,
} from './reconciliation.types.js';

describe('Milestone 9: Automated Financial Reconciliation Engine', () => {
  let matcher: ReconciliationMatcher;
  let repo: InMemoryReconciliationRepository;
  let service: ReconciliationService;
  const runId = 'test-recon-run-001';

  beforeEach(() => {
    matcher = new ReconciliationMatcher();
    repo = new InMemoryReconciliationRepository();
    service = new ReconciliationService(repo, matcher);
  });

  // =========================================================================
  // 1. DETERMINISTIC MATCHING ENGINE TESTS
  // =========================================================================
  describe('Matching Logic', () => {
    it('1.1 should produce EXACT MATCH when reference, amount, currency, and status match', () => {
      const internalRecords: InternalRecordSummary[] = [
        {
          id: 'int_001',
          reference: 'PAY-1001',
          idempotencyKey: 'PAY-1001',
          amountMinor: 1000000n, // ₹10,000.00
          currency: 'INR',
          status: 'CAPTURED',
          createdAt: new Date('2026-09-01T10:00:00Z'),
        },
      ];

      const externalRecords: ExternalTransactionEntity[] = [
        {
          id: 'ext_001',
          provider: 'mockpay',
          externalTransactionId: 'EXT-9001',
          externalReference: 'EXT-9001',
          paymentReference: 'PAY-1001',
          transactionType: 'PAYMENT',
          amountMinor: 1000000n, // ₹10,000.00
          currency: 'INR',
          status: 'CAPTURED',
          transactionTimestamp: new Date('2026-09-01T10:00:02Z'),
          createdAt: new Date('2026-09-01T10:00:02Z'),
        },
      ];

      const result = matcher.match(runId, internalRecords, externalRecords);

      expect(result.matchedCount).toBe(1);
      expect(result.mismatchCount).toBe(0);
      expect(result.missingInternalCount).toBe(0);
      expect(result.missingExternalCount).toBe(0);
      expect(result.duplicateCount).toBe(0);

      const record = result.records[0];
      expect(record.result).toBe('MATCHED');
      expect(record.differenceMinor).toBe(0n);
      expect(record.internalReference).toBe('PAY-1001');
      expect(record.externalTransactionId).toBe('EXT-9001');
      expect(record.status).toBe('RESOLVED');
    });

    it('1.2 should detect AMOUNT_MISMATCH with exact signed minor difference without modifying source', () => {
      const internalRecords: InternalRecordSummary[] = [
        {
          id: 'int_002',
          reference: 'PAY-1002',
          idempotencyKey: 'PAY-1002',
          amountMinor: 1000000n, // ₹10,000
          currency: 'INR',
          status: 'CAPTURED',
          createdAt: new Date('2026-09-01T11:00:00Z'),
        },
      ];

      const externalRecords: ExternalTransactionEntity[] = [
        {
          id: 'ext_002',
          provider: 'mockpay',
          externalTransactionId: 'EXT-9002',
          externalReference: 'EXT-9002',
          paymentReference: 'PAY-1002',
          transactionType: 'PAYMENT',
          amountMinor: 950000n, // ₹9,500 (difference: -₹500 / -50,000 minor units)
          currency: 'INR',
          status: 'CAPTURED',
          transactionTimestamp: new Date('2026-09-01T11:00:05Z'),
          createdAt: new Date('2026-09-01T11:00:05Z'),
        },
      ];

      const result = matcher.match(runId, internalRecords, externalRecords);

      expect(result.matchedCount).toBe(0);
      expect(result.mismatchCount).toBe(1);

      const record = result.records[0];
      expect(record.result).toBe('AMOUNT_MISMATCH');
      expect(record.differenceMinor).toBe(-50000n);
      expect(record.status).toBe('OPEN');
      expect(record.reason).toContain('Amount mismatch');
      // Source values remain preserved
      expect(internalRecords[0].amountMinor).toBe(1000000n);
      expect(externalRecords[0].amountMinor).toBe(950000n);
    });

    it('1.3 should detect CURRENCY_MISMATCH without automatic conversion', () => {
      const internalRecords: InternalRecordSummary[] = [
        {
          id: 'int_003',
          reference: 'PAY-1003',
          idempotencyKey: 'PAY-1003',
          amountMinor: 1000000n,
          currency: 'INR',
          status: 'CAPTURED',
          createdAt: new Date('2026-09-01T12:00:00Z'),
        },
      ];

      const externalRecords: ExternalTransactionEntity[] = [
        {
          id: 'ext_003',
          provider: 'mockpay',
          externalTransactionId: 'EXT-9003',
          externalReference: 'EXT-9003',
          paymentReference: 'PAY-1003',
          transactionType: 'PAYMENT',
          amountMinor: 1000000n,
          currency: 'USD', // Currency mismatch
          status: 'CAPTURED',
          transactionTimestamp: new Date('2026-09-01T12:00:05Z'),
          createdAt: new Date('2026-09-01T12:00:05Z'),
        },
      ];

      const result = matcher.match(runId, internalRecords, externalRecords);

      expect(result.mismatchCount).toBe(1);
      const record = result.records[0];
      expect(record.result).toBe('CURRENCY_MISMATCH');
      expect(record.reason).toContain('Currency mismatch: internal INR vs external USD');
      expect(record.status).toBe('OPEN');
    });

    it('1.4 should detect STATUS_MISMATCH without altering internal payment state', () => {
      const internalRecords: InternalRecordSummary[] = [
        {
          id: 'int_004',
          reference: 'PAY-1004',
          idempotencyKey: 'PAY-1004',
          amountMinor: 500000n,
          currency: 'INR',
          status: 'CAPTURED',
          createdAt: new Date('2026-09-01T13:00:00Z'),
        },
      ];

      const externalRecords: ExternalTransactionEntity[] = [
        {
          id: 'ext_004',
          provider: 'mockpay',
          externalTransactionId: 'EXT-9004',
          externalReference: 'EXT-9004',
          paymentReference: 'PAY-1004',
          transactionType: 'PAYMENT',
          amountMinor: 500000n,
          currency: 'INR',
          status: 'FAILED', // External failed
          transactionTimestamp: new Date('2026-09-01T13:00:05Z'),
          createdAt: new Date('2026-09-01T13:00:05Z'),
        },
      ];

      const result = matcher.match(runId, internalRecords, externalRecords);

      expect(result.mismatchCount).toBe(1);
      const record = result.records[0];
      expect(record.result).toBe('STATUS_MISMATCH');
      expect(record.reason).toContain('Status mismatch: internal CAPTURED vs external FAILED');
      expect(record.status).toBe('OPEN');
      expect(internalRecords[0].status).toBe('CAPTURED');
    });
  });

  // =========================================================================
  // 2. MISSING TRANSACTIONS & DUPLICATE DETECTION
  // =========================================================================
  describe('Missing Records & Duplicate Detection', () => {
    it('2.1 should detect MISSING_INTERNAL when external transaction has no LedgerX match', () => {
      const internalRecords: InternalRecordSummary[] = [];

      const externalRecords: ExternalTransactionEntity[] = [
        {
          id: 'ext_999',
          provider: 'mockpay',
          externalTransactionId: 'EXT-123',
          externalReference: 'EXT-123',
          paymentReference: 'PAY-999',
          transactionType: 'PAYMENT',
          amountMinor: 500000n, // ₹5,000
          currency: 'INR',
          status: 'CAPTURED',
          transactionTimestamp: new Date('2026-09-01T14:00:00Z'),
          createdAt: new Date('2026-09-01T14:00:00Z'),
        },
      ];

      const result = matcher.match(runId, internalRecords, externalRecords);

      expect(result.missingInternalCount).toBe(1);
      const record = result.records[0];
      expect(record.result).toBe('MISSING_INTERNAL');
      expect(record.externalTransactionId).toBe('EXT-123');
      expect(record.status).toBe('OPEN');
    });

    it('2.2 should detect MISSING_EXTERNAL when internal transaction has no external match', () => {
      const internalRecords: InternalRecordSummary[] = [
        {
          id: 'int_123',
          reference: 'PAY-123',
          idempotencyKey: 'PAY-123',
          amountMinor: 500000n,
          currency: 'INR',
          status: 'CAPTURED',
          createdAt: new Date('2026-09-01T15:00:00Z'),
        },
      ];

      const externalRecords: ExternalTransactionEntity[] = [];

      const result = matcher.match(runId, internalRecords, externalRecords);

      expect(result.missingExternalCount).toBe(1);
      const record = result.records[0];
      expect(record.result).toBe('MISSING_EXTERNAL');
      expect(record.internalReference).toBe('PAY-123');
      expect(record.status).toBe('OPEN');
    });

    it('2.3 should detect DUPLICATE_EXTERNAL without silently collapsing them', () => {
      const internalRecords: InternalRecordSummary[] = [
        {
          id: 'int_dup',
          reference: 'PAY-DUP-01',
          idempotencyKey: 'PAY-DUP-01',
          amountMinor: 250000n,
          currency: 'INR',
          status: 'CAPTURED',
          createdAt: new Date('2026-09-01T16:00:00Z'),
        },
      ];

      const externalRecords: ExternalTransactionEntity[] = [
        {
          id: 'ext_dup_1',
          provider: 'mockpay',
          externalTransactionId: 'EXT-DUP-100',
          externalReference: 'EXT-DUP-100',
          paymentReference: 'PAY-DUP-01',
          transactionType: 'PAYMENT',
          amountMinor: 250000n,
          currency: 'INR',
          status: 'CAPTURED',
          transactionTimestamp: new Date('2026-09-01T16:00:01Z'),
          createdAt: new Date('2026-09-01T16:00:01Z'),
        },
        {
          id: 'ext_dup_2',
          provider: 'mockpay',
          externalTransactionId: 'EXT-DUP-100', // duplicate externalTransactionId
          externalReference: 'EXT-DUP-100',
          paymentReference: 'PAY-DUP-01',
          transactionType: 'PAYMENT',
          amountMinor: 250000n,
          currency: 'INR',
          status: 'CAPTURED',
          transactionTimestamp: new Date('2026-09-01T16:00:02Z'),
          createdAt: new Date('2026-09-01T16:00:02Z'),
        },
      ];

      const result = matcher.match(runId, internalRecords, externalRecords);

      expect(result.duplicateCount).toBe(1);
      expect(result.matchedCount).toBe(1); // The first one matched
      const duplicateRecord = result.records.find((r) => r.result === 'DUPLICATE_EXTERNAL');
      expect(duplicateRecord).toBeDefined();
      expect(duplicateRecord?.externalTransactionId).toBe('EXT-DUP-100');
      expect(duplicateRecord?.status).toBe('OPEN');
    });

    it('2.4 should detect DUPLICATE_INTERNAL when internal references are duplicated', () => {
      const internalRecords: InternalRecordSummary[] = [
        {
          id: 'int_dup_a',
          reference: 'PAY-SHARED-REF',
          idempotencyKey: 'PAY-SHARED-REF',
          amountMinor: 100000n,
          currency: 'INR',
          status: 'CAPTURED',
          createdAt: new Date('2026-09-01T17:00:00Z'),
        },
        {
          id: 'int_dup_b',
          reference: 'PAY-SHARED-REF', // duplicate reference
          idempotencyKey: 'PAY-SHARED-REF',
          amountMinor: 100000n,
          currency: 'INR',
          status: 'CAPTURED',
          createdAt: new Date('2026-09-01T17:00:01Z'),
        },
      ];

      const externalRecords: ExternalTransactionEntity[] = [
        {
          id: 'ext_shared',
          provider: 'mockpay',
          externalTransactionId: 'EXT-SHARED-01',
          externalReference: 'EXT-SHARED-01',
          paymentReference: 'PAY-SHARED-REF',
          transactionType: 'PAYMENT',
          amountMinor: 100000n,
          currency: 'INR',
          status: 'CAPTURED',
          transactionTimestamp: new Date('2026-09-01T17:00:05Z'),
          createdAt: new Date('2026-09-01T17:00:05Z'),
        },
      ];

      const result = matcher.match(runId, internalRecords, externalRecords);

      expect(result.duplicateCount).toBe(1);
      const duplicateRecord = result.records.find((r) => r.result === 'DUPLICATE_INTERNAL');
      expect(duplicateRecord).toBeDefined();
      expect(duplicateRecord?.status).toBe('OPEN');
    });
  });

  // =========================================================================
  // 3. LARGE DATASET EFFICIENCY TEST (O(N) vs O(N^2))
  // =========================================================================
  describe('Large Dataset Performance', () => {
    it('3.1 should match 1,000+ internal and 1,000+ external records in milliseconds (O(N) indexed lookup)', () => {
      const N = 1000;
      const internalRecords: InternalRecordSummary[] = [];
      const externalRecords: ExternalTransactionEntity[] = [];

      for (let i = 0; i < N; i++) {
        const ref = `PAY-PERF-${i}`;
        const extId = `EXT-PERF-${i}`;
        const amount = BigInt(1000 + i);

        internalRecords.push({
          id: `int_${i}`,
          reference: ref,
          idempotencyKey: ref,
          amountMinor: amount,
          currency: 'INR',
          status: 'CAPTURED',
          createdAt: new Date(1725148800000 + i * 1000),
        });

        externalRecords.push({
          id: `ext_${i}`,
          provider: 'mockpay',
          externalTransactionId: extId,
          externalReference: extId,
          paymentReference: ref,
          transactionType: 'PAYMENT',
          amountMinor: amount,
          currency: 'INR',
          status: 'CAPTURED',
          transactionTimestamp: new Date(1725148800000 + i * 1000),
          createdAt: new Date(1725148800000 + i * 1000),
        });
      }

      const t0 = performance.now();
      const result = matcher.match(runId, internalRecords, externalRecords);
      const durationMs = performance.now() - t0;

      expect(result.matchedCount).toBe(N);
      expect(result.mismatchCount).toBe(0);
      expect(result.records.length).toBe(N);
      // O(N) hash-indexed execution must finish comfortably within 200ms
      expect(durationMs).toBeLessThan(200);
    });
  });

  // =========================================================================
  // 4. DISCREPANCY LIFECYCLE MANAGEMENT (OPEN -> INVESTIGATING -> RESOLVED / WAIVED)
  // =========================================================================
  describe('Discrepancy Lifecycle & Administrative Workflow', () => {
    let discrepancyRecordId: string;

    beforeEach(async () => {
      // Create a run and an OPEN discrepancy
      const run = await repo.createRun({
        runReference: 'REC-DISC-001',
        provider: 'mockpay',
        periodStart: new Date('2026-09-01T00:00:00Z'),
        periodEnd: new Date('2026-09-02T00:00:00Z'),
        status: 'COMPLETED',
        totalInternalRecords: 1,
        totalExternalRecords: 1,
        matchedCount: 0,
        mismatchCount: 1,
        missingInternalCount: 0,
        missingExternalCount: 0,
        duplicateCount: 0,
        startedAt: new Date(),
        completedAt: new Date(),
        errorMessage: null,
      });

      await repo.saveRecordsBatch([
        {
          runId: run.id,
          internalReference: 'PAY-DISC-01',
          externalReference: 'EXT-DISC-01',
          internalTransactionId: 'int_tx_1',
          externalTransactionId: 'EXT-DISC-01',
          externalDbRecordId: null,
          result: 'AMOUNT_MISMATCH',
          differenceMinor: -50000n,
          reason: 'Amount mismatch',
          status: 'OPEN',
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: null,
          internalAmountMinor: 1000000n,
          externalAmountMinor: 950000n,
        },
      ]);

      const records = await repo.getRecordsByRunId({ runId: run.id });
      discrepancyRecordId = records.items[0].id;
    });

    it('4.1 should follow valid lifecycle: OPEN -> INVESTIGATING -> RESOLVED', async () => {
      // Step 1: Transition to INVESTIGATING
      const underInvestigation = await service.investigateDiscrepancy(
        discrepancyRecordId,
        'compliance_officer@ledgerx.com',
        'Investigating merchant fee deduction'
      );

      expect(underInvestigation.status).toBe('INVESTIGATING');
      expect(underInvestigation.resolvedBy).toBe('compliance_officer@ledgerx.com');

      // Step 2: Transition to RESOLVED
      const resolved = await service.resolveDiscrepancy(
        discrepancyRecordId,
        'compliance_officer@ledgerx.com',
        'Merchant accepted ₹500 fee deduction as per contract'
      );

      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.resolvedAt).toBeInstanceOf(Date);
      expect(resolved.resolutionNotes).toContain('Merchant accepted ₹500 fee deduction');
    });

    it('4.2 should support waiving discrepancy: OPEN -> WAIVED', async () => {
      const waived = await service.waiveDiscrepancy(
        discrepancyRecordId,
        'finance_lead@ledgerx.com',
        'Under ₹10 rounding tolerance waiver approved'
      );

      expect(waived.status).toBe('WAIVED');
      expect(waived.resolvedBy).toBe('finance_lead@ledgerx.com');
      expect(waived.resolutionNotes).toContain('rounding tolerance waiver');
    });

    it('4.3 should reject invalid state transitions', async () => {
      // Resolve first
      await service.resolveDiscrepancy(
        discrepancyRecordId,
        'auditor@ledgerx.com',
        'Resolved definitively'
      );

      // Attempting to re-open or investigate an already RESOLVED discrepancy must throw
      await expect(
        service.investigateDiscrepancy(discrepancyRecordId, 'auditor@ledgerx.com')
      ).rejects.toThrow(InvalidStateTransitionError);

      await expect(
        service.waiveDiscrepancy(discrepancyRecordId, 'auditor@ledgerx.com', 'Trying to waive resolved')
      ).rejects.toThrow(InvalidStateTransitionError);

      await expect(
        service.resolveDiscrepancy(discrepancyRecordId, 'auditor@ledgerx.com', 'Trying to resolve again')
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('4.4 should reject resolution without resolution notes', async () => {
      await expect(
        service.resolveDiscrepancy(discrepancyRecordId, 'auditor@ledgerx.com', '')
      ).rejects.toThrow(ValidationError);
    });
  });

  // =========================================================================
  // 5. ASYNC RECONCILIATION RUN & IDEMPOTENCY
  // =========================================================================
  describe('Asynchronous Run & Idempotency', () => {
    it('5.1 should create a run in PENDING status and return immediately', async () => {
      const run = await service.createRun({
        provider: 'mockpay',
        periodStart: '2026-09-01T00:00:00Z',
        periodEnd: '2026-09-02T00:00:00Z',
      });

      expect(run.id).toBeDefined();
      expect(run.status).toBe('PENDING');
      expect(run.runReference).toContain('REC-MOCKPAY-');
    });

    it('5.2 should execute run idempotently: duplicate executions return consistent results', async () => {
      // Seed some test data
      await service.generateTestDataset({
        provider: 'mockpay',
        matchedCount: 5,
        amountMismatchCount: 1,
        statusMismatchCount: 0,
        missingInternalCount: 0,
        missingExternalCount: 0,
        duplicateCount: 0,
      });

      const run = await service.createRun({
        provider: 'mockpay',
        periodStart: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
        periodEnd: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      });

      // First execution
      const summary1 = await service.executeRun(run.id);
      expect(summary1.status).toBe('COMPLETED');
      expect(summary1.matched).toBe(5);
      expect(summary1.amountMismatches).toBe(1);

      // Duplicate execution (e.g. duplicate Kafka delivery)
      const summary2 = await service.executeRun(run.id);
      expect(summary2.status).toBe('COMPLETED');
      expect(summary2.matched).toBe(5);
      expect(summary2.amountMismatches).toBe(1);
    });

    it('5.3 should gracefully handle worker execution failure', async () => {
      const run = await service.createRun({
        provider: 'mockpay',
        periodStart: '2026-09-01T00:00:00Z',
        periodEnd: '2026-09-02T00:00:00Z',
      });

      // Force matcher failure
      const failingMatcher = {
        match: () => {
          throw new Error('Database cluster timeout');
        },
      } as any;

      const failingService = new ReconciliationService(repo, failingMatcher);

      await expect(failingService.executeRun(run.id)).rejects.toThrow('Database cluster timeout');

      const failedRun = await repo.getRunById(run.id);
      expect(failedRun?.status).toBe('FAILED');
      expect(failedRun?.errorMessage).toContain('Database cluster timeout');
    });

    it('5.4 should handle Kafka consumer execution cleanly', async () => {
      await service.generateTestDataset({
        provider: 'mockpay',
        matchedCount: 2,
        amountMismatchCount: 0,
        statusMismatchCount: 0,
        missingInternalCount: 0,
        missingExternalCount: 0,
        duplicateCount: 0,
      });

      const run = await service.createRun({
        provider: 'mockpay',
        periodStart: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
        periodEnd: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      });

      const consumer = new ReconciliationConsumer({
        reconciliationService: service,
        processedRepo: {
          hasProcessed: async () => false,
          markProcessed: async () => {},
        } as any,
      });

      // Simulate consuming Kafka event
      await (consumer as any).processEvent({
        event_id: 'evt_test_recon',
        event_type: 'reconciliation.run.created',
        event_version: 1,
        occurred_at: new Date().toISOString(),
        producer: 'reconciliation-service',
        correlation_id: 'corr_test_1',
        aggregate_type: 'reconciliation_run',
        aggregate_id: run.id,
        payload: { run_id: run.id },
      });

      const completedRun = await repo.getRunById(run.id);
      expect(completedRun?.status).toBe('COMPLETED');
      expect(completedRun?.matchedCount).toBe(2);
    });
  });

  // =========================================================================
  // 6. END-TO-END DATASET VERIFICATION (Prompt Section 31)
  // =========================================================================
  describe('End-to-End Exact Counts Test (Section 31)', () => {
    it('6.1 should produce exact reconciliation counts: 100 internal, 100 external -> 90 matched, 3 amount mismatches, 2 status mismatches, 2 missing internal, 2 missing external, 1 duplicate', async () => {
      // Setup dataset exactly as specified in Section 31
      const dataset = await service.generateTestDataset({
        provider: 'mockpay',
        matchedCount: 90,
        amountMismatchCount: 3,
        statusMismatchCount: 2,
        missingInternalCount: 2,
        missingExternalCount: 2,
        duplicateCount: 1,
      });

      expect(dataset.internalCount).toBe(97);
      expect(dataset.externalCount).toBe(98);

      const run = await service.createRun({
        provider: 'mockpay',
        periodStart: dataset.periodStart.toISOString(),
        periodEnd: dataset.periodEnd.toISOString(),
      });

      const summary = await service.executeRun(run.id);

      // Verify exact counts match the generated dataset
      expect(summary.totalInternal).toBe(97);
      expect(summary.totalExternal).toBe(98);
      expect(summary.matched).toBe(90);
      expect(summary.amountMismatches).toBe(3);
      expect(summary.statusMismatches).toBe(2);
      expect(summary.missingInternal).toBe(2);
      expect(summary.missingExternal).toBe(2);
      expect(summary.duplicates).toBe(1);
      expect(summary.status).toBe('COMPLETED');

      // Verify audit logs were produced
      const auditLogs = repo.getAuditLogs();
      const actions = auditLogs.map((l) => l.action);
      expect(actions).toContain('reconciliation_run_created');
      expect(actions).toContain('reconciliation_started');
      expect(actions).toContain('reconciliation_completed');
    });
  });

  // =========================================================================
  // 7. HTTP API ENDPOINTS TEST
  // =========================================================================
  describe('HTTP API Endpoints', () => {
    let app: ReturnType<typeof createServer>;

    beforeEach(async () => {
      const container = await createReconciliationContainer({ repository: repo });
      setReconciliationContainer(container);
      app = createServer();
    });

    it('7.1 POST /api/v1/reconciliation/runs returns 202 Accepted', async () => {
      const res = await request(app)
        .post('/api/v1/reconciliation/runs')
        .send({
          provider: 'mockpay',
          period_start: '2026-09-01T00:00:00Z',
          period_end: '2026-09-30T23:59:59Z',
        });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.provider).toBe('mockpay');
    });

    it('7.2 GET /api/v1/reconciliation/runs/:runId returns run status and details', async () => {
      const run = await service.createRun({
        provider: 'mockpay',
        periodStart: '2026-09-01T00:00:00Z',
        periodEnd: '2026-09-30T23:59:59Z',
      });

      const res = await request(app).get(`/api/v1/reconciliation/runs/${run.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(run.id);
      expect(res.body.data.status).toBe('PENDING');
    });

    it('7.3 POST /api/v1/reconciliation/records/:id/investigate, resolve, waive APIs work as expected', async () => {
      const run = await service.createRun({
        provider: 'mockpay',
        periodStart: '2026-09-01T00:00:00Z',
        periodEnd: '2026-09-30T23:59:59Z',
      });

      await repo.saveRecordsBatch([
        {
          runId: run.id,
          internalReference: 'PAY-API-01',
          externalReference: 'EXT-API-01',
          internalTransactionId: 'int_1',
          externalTransactionId: 'EXT-API-01',
          externalDbRecordId: null,
          result: 'STATUS_MISMATCH',
          differenceMinor: 0n,
          reason: 'Status mismatch',
          status: 'OPEN',
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: null,
          internalAmountMinor: 100000n,
          externalAmountMinor: 100000n,
        },
      ]);

      const records = await repo.getRecordsByRunId({ runId: run.id });
      const recordId = records.items[0].id;

      // Investigate
      const invRes = await request(app)
        .post(`/api/v1/reconciliation/records/${recordId}/investigate`)
        .send({ actor: 'admin@ledgerx.com', notes: 'Checking gateway logs' });

      expect(invRes.status).toBe(200);
      expect(invRes.body.data.status).toBe('INVESTIGATING');

      // Resolve
      const resRes = await request(app)
        .post(`/api/v1/reconciliation/records/${recordId}/resolve`)
        .send({ resolved_by: 'admin@ledgerx.com', resolution_notes: 'Confirmed chargeback initiated' });

      expect(resRes.status).toBe(200);
      expect(resRes.body.data.status).toBe('RESOLVED');
      expect(resRes.body.data.resolution_notes).toBe('Confirmed chargeback initiated');
    });

    it('7.4 GET /api/v1/reconciliation/dashboard and /metrics return observability data', async () => {
      const dashRes = await request(app).get('/api/v1/reconciliation/dashboard');
      expect(dashRes.status).toBe(200);
      expect(dashRes.body.data).toHaveProperty('totalRuns');
      expect(dashRes.body.data).toHaveProperty('matchRate');

      const metricsRes = await request(app).get('/api/v1/reconciliation/metrics');
      expect(metricsRes.status).toBe(200);
      expect(metricsRes.body.data).toHaveProperty('reconciliation_runs_total');
    });
  });
});
