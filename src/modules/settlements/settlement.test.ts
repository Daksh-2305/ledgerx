import { describe, it, expect, beforeEach } from 'vitest';
import supertest from 'supertest';
import { createServer } from '../../server.js';
import {
  InMemorySettlementRepository,
} from './settlement.repository.js';
import { SettlementService } from './settlement.service.js';
import { SettlementCalculator } from './settlement.calculator.js';
import { SettlementConsumer } from './settlement-consumer.service.js';
import {
  SettlementBatchStatus,
  SettlementRecordStatus,
} from './settlement.types.js';
import {
  createSettlementContainer,
  setSettlementContainer,
  resetSettlementContainer,
} from './settlement.container.js';
import { InMemoryLedgerRepository } from '../ledger/ledger.repository.js';
import { LedgerService } from '../ledger/ledger.service.js';
import {
  createLedgerContainer,
  setLedgerContainer,
  resetLedgerContainer,
} from '../ledger/ledger.container.js';
import {
  ConflictError,
  FinancialInvarianceError,
} from '../../common/errors.js';
import { EventEnvelope } from '../../infra/kafka/event-envelope.js';

describe('Milestone 10 — Settlement & Settlement Batches', () => {
  let app: any;
  let settlementRepo: InMemorySettlementRepository;
  let ledgerRepo: InMemoryLedgerRepository;
  let ledgerService: LedgerService;
  let settlementService: SettlementService;

  const merchantId = '00000000-0000-0000-0000-000000000001';
  const currency = 'INR';
  const periodStart = '2026-09-01T00:00:00.000Z';
  const periodEnd = '2026-09-30T23:59:59.999Z';

  beforeEach(async () => {
    // Reset ALL containers to ensure test isolation in CI where PostgreSQL is available
    resetLedgerContainer();
    resetSettlementContainer();

    settlementRepo = new InMemorySettlementRepository();
    ledgerRepo = new InMemoryLedgerRepository();
    ledgerService = new LedgerService(ledgerRepo);

    const ledgerContainer = await createLedgerContainer(ledgerRepo);
    setLedgerContainer(ledgerContainer);

    settlementService = new SettlementService(
      settlementRepo,
      ledgerService
    );

    const container = await createSettlementContainer({
      repository: settlementRepo,
      ledgerService,
      service: settlementService,
    });
    setSettlementContainer(container);

    app = createServer();
  });

  describe('1. Batch Creation & API (Section 7 & 13)', () => {
    it('creates a new settlement batch and returns 202 Accepted', async () => {
      const res = await supertest(app)
        .post('/api/v1/settlements/batches')
        .send({
          merchant_id: merchantId,
          currency,
          period_start: periodStart,
          period_end: periodEnd,
          fee_bps: 200,
        });

      expect(res.status).toBe(202);
      expect(res.body.batch).toBeDefined();
      expect(res.body.batch.merchant_id).toBe(merchantId);
      expect(res.body.batch.currency).toBe('INR');
      expect(res.body.batch.status).toBe('PENDING');
      expect(res.body.batch.batch_reference).toMatch(/^SETTLE-/);
    });

    it('rejects batch creation with invalid dates (start > end)', async () => {
      const res = await supertest(app)
        .post('/api/v1/settlements/batches')
        .send({
          merchant_id: merchantId,
          currency,
          period_start: '2026-10-01T00:00:00.000Z',
          period_end: '2026-09-01T00:00:00.000Z',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('2. Settlement Idempotency (Section 10)', () => {
    it('repeated requests for same merchant + currency + period return existing batch without duplicate creation', async () => {
      const res1 = await supertest(app)
        .post('/api/v1/settlements/batches')
        .send({
          merchant_id: merchantId,
          currency,
          period_start: periodStart,
          period_end: periodEnd,
        });

      expect(res1.status).toBe(202);
      const batch1Id = res1.body.batch.id;

      const res2 = await supertest(app)
        .post('/api/v1/settlements/batches')
        .send({
          merchant_id: merchantId,
          currency,
          period_start: periodStart,
          period_end: periodEnd,
        });

      expect(res2.status).toBe(202);
      expect(res2.body.batch.id).toBe(batch1Id);

      // Verify repository only has 1 batch
      const batches = await settlementRepo.findBatches({});
      expect(batches.total).toBe(1);
    });
  });

  describe('3. Settlement Calculation & Minor Units (Section 4 & 11)', () => {
    it('calculates Net = Gross - Refunds - Fees + Adjustments accurately with integer minor units', () => {
      // Example from specification:
      // Gross: ₹100,000 (10,000,000 minor)
      // Refunds: ₹10,000 (1,000,000 minor)
      // Fees: ₹2,000 (200,000 minor)
      // Adjustments: ₹1,000 (100,000 minor)
      // Net: ₹89,000 (8,900,000 minor)
      const items = [
        {
          paymentId: 'pay-1',
          merchantId,
          currency: 'INR',
          capturedAmountMinor: 10000000n,
          refundedAmountMinor: 1000000n,
          isEligible: true,
        },
      ];

      const result = SettlementCalculator.calculateBatch(items, {
        feeBps: 200, // 200 bps on 10,000,000 = 200,000
        adjustmentAmountMinor: 100000n,
      });

      expect(result.grossAmountMinor).toBe(10000000n);
      expect(result.refundAmountMinor).toBe(1000000n);
      expect(result.feeAmountMinor).toBe(200000n);
      expect(result.adjustmentAmountMinor).toBe(100000n);
      expect(result.netAmountMinor).toBe(8900000n);
      expect(result.recordCount).toBe(1);
    });

    it('throws FinancialInvarianceError if refund exceeds gross amount', () => {
      const items = [
        {
          paymentId: 'pay-bad',
          merchantId,
          currency: 'INR',
          capturedAmountMinor: 50000n,
          refundedAmountMinor: 60000n,
          isEligible: true,
        },
      ];

      expect(() =>
        SettlementCalculator.calculateBatch(items, { feeBps: 200 })
      ).toThrow(FinancialInvarianceError);
    });

    it('enforces invariants: SUM(records) == batch totals', () => {
      const items = [
        {
          paymentId: 'pay-1',
          merchantId,
          currency: 'INR',
          capturedAmountMinor: 200000n,
          refundedAmountMinor: 0n,
          isEligible: true,
        },
        {
          paymentId: 'pay-2',
          merchantId,
          currency: 'INR',
          capturedAmountMinor: 300000n,
          refundedAmountMinor: 50000n,
          isEligible: true,
        },
      ];

      const result = SettlementCalculator.calculateBatch(items, { feeBps: 200 });
      expect(result.grossAmountMinor).toBe(500000n);
      expect(result.refundAmountMinor).toBe(50000n);
      expect(result.feeAmountMinor).toBe(10000n); // (200000*200/10000 = 4000) + (300000*200/10000 = 6000) = 10000
      expect(result.netAmountMinor).toBe(500000n - 50000n - 10000n); // 440000n
    });
  });

  describe('4. Eligibility & Reconciliation Integration (Section 5 & 6)', () => {
    it('excludes payments with unresolved reconciliation discrepancies from settlement', async () => {
      // Setup mock payments in repository
      settlementRepo.setMockPayments([
        {
          id: 'pay-clean',
          merchantId,
          currency: 'INR',
          status: 'CAPTURED',
          amountMinor: 100000n,
          capturedAmountMinor: 100000n,
          refundedAmountMinor: 0n,
          createdAt: new Date('2026-09-10T10:00:00Z'),
          updatedAt: new Date('2026-09-10T10:00:00Z'),
        },
        {
          id: 'pay-discrepant',
          merchantId,
          currency: 'INR',
          status: 'CAPTURED',
          amountMinor: 200000n,
          capturedAmountMinor: 200000n,
          refundedAmountMinor: 0n,
          createdAt: new Date('2026-09-11T10:00:00Z'),
          updatedAt: new Date('2026-09-11T10:00:00Z'),
        },
      ]);

      // Set open discrepancy for pay-discrepant
      settlementRepo.setMockDiscrepancy('pay-discrepant', {
        id: 'disc-1',
        runId: 'run-1',
        discrepancyType: 'AMOUNT_MISMATCH',
        status: 'OPEN',
      });

      // Create and process batch
      const batch = await settlementService.createSettlementBatch({
        merchantId,
        currency,
        periodStart,
        periodEnd,
        feeBps: 200,
      });

      const processed = await settlementService.processBatch(batch.id, { feeBps: 200 });

      expect(processed.status).toBe(SettlementBatchStatus.READY);
      expect(processed.recordCount).toBe(1); // Only pay-clean included
      expect(processed.grossAmountMinor).toBe(100000n);

      // Verify records in repository
      const recordsRes = await settlementRepo.findRecordsByBatchId({ batchId: batch.id });
      expect(recordsRes.records.length).toBe(2);

      const cleanRecord = recordsRes.records.find((r) => r.paymentId === 'pay-clean');
      const discrepantRecord = recordsRes.records.find((r) => r.paymentId === 'pay-discrepant');

      expect(cleanRecord?.status).toBe(SettlementRecordStatus.INCLUDED);
      expect(discrepantRecord?.status).toBe(SettlementRecordStatus.EXCLUDED);
      expect(discrepantRecord?.errorMessage).toContain('AMOUNT_MISMATCH');
    });

    it('does not include payments already settled in another batch', async () => {
      // Payment already settled
      settlementRepo.setMockPayments([
        {
          id: 'pay-settled-previously',
          merchantId,
          currency: 'INR',
          status: 'SETTLED',
          amountMinor: 100000n,
          capturedAmountMinor: 100000n,
          refundedAmountMinor: 0n,
          createdAt: new Date('2026-09-05T10:00:00Z'),
          updatedAt: new Date('2026-09-05T10:00:00Z'),
        },
      ]);

      // Simulate prior record
      await settlementRepo.createRecordsBatch([
        {
          id: 'rec-prev',
          batchId: 'prior-batch-id',
          paymentId: 'pay-settled-previously',
          merchantId,
          currency: 'INR',
          grossAmountMinor: 100000n,
          refundAmountMinor: 0n,
          feeAmountMinor: 2000n,
          netAmountMinor: 98000n,
          status: SettlementRecordStatus.SETTLED,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const batch = await settlementService.createSettlementBatch({
        merchantId,
        currency,
        periodStart,
        periodEnd,
      });

      const processed = await settlementService.processBatch(batch.id);
      expect(processed.recordCount).toBe(0); // Excluded because already settled
    });
  });

  describe('5. State Machine & Transitions (Section 9)', () => {
    it('enforces strict transitions: PENDING -> PROCESSING -> RECONCILED -> READY -> PROCESSING_SETTLEMENT -> SETTLED', async () => {
      settlementRepo.setMockPayments([
        {
          id: 'pay-1',
          merchantId,
          currency: 'INR',
          status: 'CAPTURED',
          amountMinor: 50000n,
          capturedAmountMinor: 50000n,
          refundedAmountMinor: 0n,
          createdAt: new Date('2026-09-15T12:00:00Z'),
          updatedAt: new Date('2026-09-15T12:00:00Z'),
        },
      ]);

      const batch = await settlementService.createSettlementBatch({
        merchantId,
        currency,
        periodStart,
        periodEnd,
        feeBps: 200,
      });
      expect(batch.status).toBe(SettlementBatchStatus.PENDING);

      const ready = await settlementService.processBatch(batch.id);
      expect(ready.status).toBe(SettlementBatchStatus.READY);

      const settled = await settlementService.executeSettlement(batch.id);
      expect(settled.status).toBe(SettlementBatchStatus.SETTLED);
      expect(settled.completedAt).toBeDefined();
    });

    it('rejects invalid state transition (SETTLED -> PENDING)', async () => {
      const batch = await settlementService.createSettlementBatch({
        merchantId,
        currency,
        periodStart,
        periodEnd,
      });

      await settlementService.processBatch(batch.id);
      await settlementService.executeSettlement(batch.id);

      await expect(
        settlementService.transitionStatus(batch.id, SettlementBatchStatus.PENDING)
      ).rejects.toThrow(ConflictError);
    });

    it('rejects invalid transition (FAILED -> SETTLED)', async () => {
      const batch = await settlementService.createSettlementBatch({
        merchantId,
        currency,
        periodStart,
        periodEnd,
      });

      await settlementService.transitionStatus(batch.id, SettlementBatchStatus.FAILED);

      await expect(
        settlementService.transitionStatus(batch.id, SettlementBatchStatus.SETTLED)
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('6. Settlement Ledger Integration (Section 12)', () => {
    it('creates a balanced double-entry transaction when batch is settled', async () => {
      settlementRepo.setMockPayments([
        {
          id: 'pay-100',
          merchantId,
          currency: 'INR',
          status: 'CAPTURED',
          amountMinor: 1000000n, // ₹10,000.00
          capturedAmountMinor: 1000000n,
          refundedAmountMinor: 0n,
          createdAt: new Date('2026-09-20T10:00:00Z'),
          updatedAt: new Date('2026-09-20T10:00:00Z'),
        },
      ]);

      const batch = await settlementService.createSettlementBatch({
        merchantId,
        currency,
        periodStart,
        periodEnd,
        feeBps: 200, // 20,000 fee minor -> net = 980,000
      });

      await settlementService.processBatch(batch.id);
      const settled = await settlementService.executeSettlement(batch.id);

      expect(settled.status).toBe(SettlementBatchStatus.SETTLED);
      expect(settled.ledgerTransactionId).toBeDefined();

      // Retrieve ledger transaction and verify balanced double-entry
      const ledgerTx = await ledgerRepo.findTransactionById(settled.ledgerTransactionId!);
      expect(ledgerTx).toBeDefined();
      expect(ledgerTx?.referenceType).toBe('SETTLEMENT');
      expect(ledgerTx?.referenceId).toBe(batch.id);
      expect(ledgerTx?.entries.length).toBe(2);

      const debitEntry = ledgerTx?.entries.find((e) => e.entryType === 'DEBIT');
      const creditEntry = ledgerTx?.entries.find((e) => e.entryType === 'CREDIT');

      expect(debitEntry).toBeDefined();
      expect(creditEntry).toBeDefined();
      expect(debitEntry?.amountMinor).toBe(settled.netAmountMinor);
      expect(creditEntry?.amountMinor).toBe(settled.netAmountMinor);
      expect(debitEntry?.amountMinor).toBe(creditEntry?.amountMinor);
    });
  });

  describe('7. Kafka Duplicate Event Delivery & Consumer (Section 8 & 10)', () => {
    it('safely handles duplicate delivery of settlement.batch.created event', async () => {
      settlementRepo.setMockPayments([
        {
          id: 'pay-kafka-1',
          merchantId,
          currency: 'INR',
          status: 'CAPTURED',
          amountMinor: 500000n,
          capturedAmountMinor: 500000n,
          refundedAmountMinor: 0n,
          createdAt: new Date('2026-09-18T10:00:00Z'),
          updatedAt: new Date('2026-09-18T10:00:00Z'),
        },
      ]);

      const batch = await settlementService.createSettlementBatch({
        merchantId,
        currency,
        periodStart,
        periodEnd,
        feeBps: 200,
      });

      const consumer = new SettlementConsumer({ settlementService });

      const testEvent: EventEnvelope = {
        event_id: 'evt-test-1',
        event_type: 'settlement.batch.created',
        event_version: 1,
        occurred_at: new Date().toISOString(),
        producer: 'test',
        correlation_id: 'corr-1',
        aggregate_type: 'SettlementBatch',
        aggregate_id: batch.id,
        payload: {
          batch_id: batch.id,
          fee_bps: 200,
        },
      };

      // Deliver 1st time
      await (consumer as any).processEvent(testEvent);
      let updatedBatch = await settlementRepo.findBatchById(batch.id);
      expect(updatedBatch?.status).toBe(SettlementBatchStatus.READY);

      // Deliver duplicate 2nd time
      await (consumer as any).processEvent(testEvent);
      updatedBatch = await settlementRepo.findBatchById(batch.id);
      expect(updatedBatch?.status).toBe(SettlementBatchStatus.READY);
      expect(updatedBatch?.grossAmountMinor).toBe(500000n);
    });
  });

  describe('8. Concurrency & Race Protection (Section 16)', () => {
    it('concurrent batch creation attempts for same parameters yield one logical batch', async () => {
      const results = await Promise.all([
        settlementService.createSettlementBatch({
          merchantId,
          currency,
          periodStart,
          periodEnd,
        }),
        settlementService.createSettlementBatch({
          merchantId,
          currency,
          periodStart,
          periodEnd,
        }),
        settlementService.createSettlementBatch({
          merchantId,
          currency,
          periodStart,
          periodEnd,
        }),
      ]);

      // All returned batch references and IDs must match
      const firstId = results[0].id;
      for (const res of results) {
        expect(res.id).toBe(firstId);
      }

      const count = (await settlementRepo.findBatches({})).total;
      expect(count).toBe(1);
    });
  });

  describe('9. Settlement Reporting API (Section 14)', () => {
    it('returns structured settlement report with real database calculations', async () => {
      settlementRepo.setMockPayments([
        {
          id: 'pay-rep-1',
          merchantId,
          currency: 'INR',
          status: 'CAPTURED',
          amountMinor: 2500000n, // ₹25,000.00
          capturedAmountMinor: 2500000n,
          refundedAmountMinor: 500000n, // ₹5,000.00 refund
          createdAt: new Date('2026-09-12T10:00:00Z'),
          updatedAt: new Date('2026-09-12T10:00:00Z'),
        },
      ]);

      const batch = await settlementService.createSettlementBatch({
        merchantId,
        currency,
        periodStart,
        periodEnd,
        feeBps: 200,
        adjustmentAmountMinor: 10000n,
      });

      await settlementService.processBatch(batch.id);

      const res = await supertest(app).get(`/api/v1/settlements/${batch.id}/report`);
      expect(res.status).toBe(200);

      const report = res.body.data;
      expect(report.batchId).toBe(batch.id);
      expect(report.merchantId).toBe(merchantId);
      expect(report.currency).toBe('INR');
      expect(report.amounts.grossMinor).toBe(2500000);
      expect(report.amounts.refundMinor).toBe(500000);
      expect(report.amounts.feeMinor).toBe(50000); // 2500000 * 200 / 10000 = 50000
      expect(report.amounts.adjustmentMinor).toBe(10000);
      expect(report.amounts.netMinor).toBe(2500000 - 500000 - 50000 + 10000); // 1960000
      expect(report.status).toBe('READY');
      expect(report.recordCount).toBe(1);
    });
  });

  describe('10. End-to-End REST APIs (Section 13)', () => {
    it('supports listing, pagination, record detail, and settle via HTTP', async () => {
      settlementRepo.setMockPayments([
        {
          id: 'pay-http-1',
          merchantId,
          currency: 'INR',
          status: 'CAPTURED',
          amountMinor: 100000n,
          capturedAmountMinor: 100000n,
          refundedAmountMinor: 0n,
          createdAt: new Date('2026-09-14T10:00:00Z'),
          updatedAt: new Date('2026-09-14T10:00:00Z'),
        },
      ]);

      // 1. POST /batches
      const createRes = await supertest(app)
        .post('/api/v1/settlements/batches')
        .send({
          merchant_id: merchantId,
          currency,
          period_start: periodStart,
          period_end: periodEnd,
        });
      const batchId = createRes.body.batch.id;

      // 2. POST /:id/process
      const processRes = await supertest(app).post(`/api/v1/settlements/${batchId}/process`).send();
      expect(processRes.status).toBe(200);
      expect(processRes.body.data.status).toBe('READY');

      // 3. GET /:id/records
      const recordsRes = await supertest(app).get(`/api/v1/settlements/${batchId}/records`);
      expect(recordsRes.status).toBe(200);
      expect(recordsRes.body.data.length).toBe(1);
      expect(recordsRes.body.pagination.total).toBe(1);

      // 4. POST /:id/settle
      const settleRes = await supertest(app).post(`/api/v1/settlements/${batchId}/settle`).send();
      expect(settleRes.status).toBe(200);
      expect(settleRes.body.data.status).toBe('SETTLED');

      // 5. GET /
      const listRes = await supertest(app).get('/api/v1/settlements?merchant_id=' + merchantId);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.length).toBe(1);
      expect(listRes.body.data[0].id).toBe(batchId);
    });
  });
});
