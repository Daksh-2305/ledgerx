import { describe, it, expect, beforeEach } from 'vitest';
import supertest from 'supertest';
import { createServer } from '../../server.js';
import { InMemorySettlementRepository } from '../settlements/settlement.repository.js';
import { SettlementService } from '../settlements/settlement.service.js';
import {
  createSettlementContainer,
  setSettlementContainer,
  resetSettlementContainer,
} from '../settlements/settlement.container.js';
import { InMemoryLedgerRepository } from '../ledger/ledger.repository.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { setLedgerContainer, createLedgerContainer, resetLedgerContainer } from '../ledger/ledger.container.js';
import { InMemoryPaymentRepository } from '../payments/payment.repository.js';
import { PaymentService } from '../payments/payment.service.js';
import { setPaymentContainer, createPaymentContainer, resetPaymentContainer, seedDemoData } from '../payments/payment.container.js';
import { InMemoryWebhookRepository } from '../webhooks/webhook.repository.js';
import { WebhookService } from '../webhooks/webhook.service.js';
import { setWebhookContainer, createWebhookContainer, resetWebhookContainer } from '../webhooks/webhook.container.js';
import { InMemoryRiskRepository } from '../risk/risk.repository.js';
import { RiskService } from '../risk/risk.service.js';
import { setRiskContainer, createRiskContainer, resetRiskContainer } from '../risk/risk.container.js';
import { InMemoryReconciliationRepository } from '../reconciliation/reconciliation.repository.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { ReconciliationMatcher } from '../reconciliation/reconciliation-matcher.js';
import { setReconciliationContainer, createReconciliationContainer, resetReconciliationContainer } from '../reconciliation/reconciliation.container.js';
import { generateHmacSignature } from '../webhooks/webhook.types.js';
import { resetIdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { config } from '../../config/index.js';

describe('Milestone 10 & 11 — Complete End-to-End Financial Lifecycle (Section 45)', () => {
  let app: any;
  let ledgerRepo: InMemoryLedgerRepository;
  let ledgerService: LedgerService;
  let paymentRepo: InMemoryPaymentRepository;
  let paymentService: PaymentService;
  let settlementRepo: InMemorySettlementRepository;
  let settlementService: SettlementService;
  let webhookRepo: InMemoryWebhookRepository;
  let webhookService: WebhookService;
  let riskRepo: InMemoryRiskRepository;
  let riskService: RiskService;
  let reconRepo: InMemoryReconciliationRepository;
  let reconService: ReconciliationService;

  beforeEach(async () => {
    resetLedgerContainer();
    resetPaymentContainer();
    resetSettlementContainer();
    resetWebhookContainer();
    resetRiskContainer();
    resetReconciliationContainer();
    resetIdempotencyService();

    // 1. Ledger
    ledgerRepo = new InMemoryLedgerRepository();
    ledgerService = new LedgerService(ledgerRepo);
    const ledgerContainer = await createLedgerContainer(ledgerRepo);
    (ledgerContainer as any).service = ledgerService;
    setLedgerContainer(ledgerContainer);

    // 2. Payments
    paymentRepo = new InMemoryPaymentRepository();
    await seedDemoData(paymentRepo);
    const paymentContainer = await createPaymentContainer(paymentRepo);
    paymentService = paymentContainer.service;
    setPaymentContainer(paymentContainer);

    // 3. Risk
    riskRepo = new InMemoryRiskRepository();
    const riskContainer = await createRiskContainer({ repository: riskRepo });
    riskService = riskContainer.service;
    setRiskContainer(riskContainer);

    // 4. Webhooks
    webhookRepo = new InMemoryWebhookRepository();
    const webhookContainer = await createWebhookContainer({ webhookRepo });
    webhookService = webhookContainer.service;
    setWebhookContainer(webhookContainer);

    // 5. Reconciliation
    reconRepo = new InMemoryReconciliationRepository();
    reconService = new ReconciliationService(reconRepo, new ReconciliationMatcher());
    const reconContainer = await createReconciliationContainer({ repository: reconRepo });
    (reconContainer as any).service = reconService;
    setReconciliationContainer(reconContainer);

    // 6. Settlements
    settlementRepo = new InMemorySettlementRepository();
    settlementService = new SettlementService(settlementRepo, ledgerService);
    const settlementContainer = await createSettlementContainer({
      repository: settlementRepo,
      ledgerService,
      service: settlementService,
    });
    setSettlementContainer(settlementContainer);

    app = createServer();
  });

  it('executes the full 19-step end-to-end integration scenario', async () => {
    // Step 1: Create merchant
    const merchantId = '00000000-0000-0000-0000-000000000001';

    // Step 2: Create customer
    const customerId = '00000000-0000-0000-0000-000000000010';

    // Step 3: Create payment
    const createPayRes = await supertest(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', 'idemp_e2e_pay_1')
      .send({
        merchant_id: merchantId,
        customer_id: customerId,
        amount_minor: 100000,
        currency: 'INR',
        description: 'E2E Complete Scenario Payment',
      });
    expect(createPayRes.status).toBe(201);
    const paymentId = createPayRes.body.data.id;
    expect(paymentId).toBeDefined();

    // Step 4: Risk evaluation
    const riskRes = await riskService.evaluatePayment({
      paymentId,
      merchantId,
      customerId,
      amountMinor: 100000n, // ₹1,000.00
      currency: 'INR',
    });
    expect(riskRes.decision).toBe('ALLOW');
    expect(riskRes.riskScore).toBeLessThan(50);

    // Step 5: Authorize payment
    // First initiate
    await supertest(app).post(`/api/v1/payments/${paymentId}/initiate`).send();
    // Then authorize
    const authRes = await supertest(app)
      .post(`/api/v1/payments/${paymentId}/authorize`)
      .send();
    expect(authRes.status).toBe(200);
    expect(authRes.body.data.status).toBe('AUTHORIZED');

    // Step 6: Capture payment
    const captureRes = await supertest(app)
      .post(`/api/v1/payments/${paymentId}/capture`)
      .set('Idempotency-Key', 'idemp_e2e_cap_1')
      .send();
    expect(captureRes.status).toBe(200);
    expect(captureRes.body.data.status).toBe('CAPTURED');

    // Step 7: Verify ledger entries
    const ledgerTx = await ledgerRepo.findTransactionByReference('PAYMENT', paymentId);
    expect(ledgerTx).toBeDefined();
    expect(ledgerTx?.transactionType).toBe('CAPTURE');
    expect(ledgerTx?.entries.length).toBe(2);

    const debitEntry = ledgerTx?.entries.find((e) => e.entryType === 'DEBIT');
    const creditEntry = ledgerTx?.entries.find((e) => e.entryType === 'CREDIT');
    expect(debitEntry?.amountMinor).toBe(100000n);
    expect(creditEntry?.amountMinor).toBe(100000n);
    expect(debitEntry?.amountMinor).toBe(creditEntry?.amountMinor);

    // Step 8: Send duplicate webhook
    const rawWebhookPayload = {
      event_id: 'evt_provider_captured_1',
      event_type: 'payment.captured',
      data: {
        payment_id: paymentId,
        external_reference: 'mockpay_tx_12345',
        amount: 100000,
        currency: 'INR',
        status: 'CAPTURED',
      },
    };
    const rawBody = JSON.stringify(rawWebhookPayload);
    const signature = generateHmacSignature(config.WEBHOOK_SECRET, rawBody);

    const wh1 = await webhookService.ingestWebhook({
      provider: 'mockpay',
      rawBody,
      signature,
      correlationId: 'corr_e2e_wh1',
    });
    expect(wh1.received).toBe(true);
    expect(wh1.duplicate).toBe(false);

    // Step 9: Verify no duplicate financial effect on duplicate webhook delivery
    const wh2 = await webhookService.ingestWebhook({
      provider: 'mockpay',
      rawBody,
      signature,
      correlationId: 'corr_e2e_wh2',
    });
    expect(wh2.received).toBe(true);
    expect(wh2.duplicate).toBe(true); // Handled idempotently

    // Verify ledger still has exactly 1 capture transaction
    const allCaptureTx = (await ledgerRepo.findTransactions({})).transactions.filter(
      (tx) => tx.referenceId === paymentId
    );
    expect(allCaptureTx.length).toBe(1);

    // Step 10: Create partial refund
    const refund1Res = await supertest(app)
      .post(`/api/v1/payments/${paymentId}/refund`)
      .set('Idempotency-Key', 'idemp_refund_partial_1')
      .send({
        amount_minor: 20000, // ₹200.00
        currency: 'INR',
        reason: 'Customer return part 1',
      });
    expect(refund1Res.status).toBe(201);
    expect(refund1Res.body.data.amount_minor).toBe(20000);
    expect(refund1Res.body.data.status).toBe('COMPLETED');

    // Step 11: Create second partial refund
    const refund2Res = await supertest(app)
      .post(`/api/v1/payments/${paymentId}/refund`)
      .set('Idempotency-Key', 'idemp_refund_partial_2')
      .send({
        amount_minor: 10000, // ₹100.00
        currency: 'INR',
        reason: 'Customer return part 2',
      });
    expect(refund2Res.status).toBe(201);
    expect(refund2Res.body.data.amount_minor).toBe(10000);

    // Step 12: Verify refund limits (remaining = 1000 - 200 - 100 = 700; trying 800 must fail)
    const refundExcessRes = await supertest(app)
      .post(`/api/v1/payments/${paymentId}/refund`)
      .set('Idempotency-Key', 'idemp_refund_excess')
      .send({
        amount_minor: 80000, // Exceeds remaining refundable ₹700.00
        currency: 'INR',
        reason: 'Excessive refund attempt',
      });
    expect(refundExcessRes.status).toBe(422);

    // Step 13: Generate external provider records
    const externalRecords = [
      {
        provider: 'mockpay',
        externalTransactionId: 'mockpay_tx_12345',
        externalReference: 'mockpay_tx_12345',
        paymentReference: paymentId,
        transactionType: 'PAYMENT',
        amountMinor: 100000n,
        currency: 'INR',
        status: 'CAPTURED',
        transactionTimestamp: new Date('2026-09-15T10:00:00Z'),
      },
    ];

    await reconRepo.saveExternalTransactionsBatch(externalRecords as any);
    reconRepo.addInternalRecords([
      {
        id: paymentId,
        reference: paymentId,
        amountMinor: 100000n,
        currency: 'INR',
        status: 'CAPTURED',
        createdAt: new Date('2026-09-15T10:00:00Z'),
      },
    ]);

    // Step 14: Run reconciliation
    const reconRun = await reconService.createRun({
      provider: 'mockpay',
      periodStart: '2026-09-01T00:00:00Z',
      periodEnd: '2026-09-30T23:59:59Z',
    });
    const executedRun = await reconService.executeRun(reconRun.id);

    // Step 15: Verify reconciliation result
    expect(executedRun.status).toBe('COMPLETED');
    expect(executedRun.matched).toBe(1);
    expect(executedRun.amountMismatches).toBe(0);

    // Step 16: Create settlement batch
    settlementRepo.setMockPayments([
      {
        id: paymentId,
        merchantId,
        currency: 'INR',
        status: 'CAPTURED',
        amountMinor: 100000n,
        capturedAmountMinor: 100000n,
        refundedAmountMinor: 30000n, // ₹300.00 total refunds
        createdAt: new Date('2026-09-15T10:00:00Z'),
        updatedAt: new Date('2026-09-15T10:05:00Z'),
      },
    ]);

    const batch = await settlementService.createSettlementBatch({
      merchantId,
      currency: 'INR',
      periodStart: '2026-09-01T00:00:00Z',
      periodEnd: '2026-09-30T23:59:59Z',
      feeBps: 200, // 2.0% MDR
    });

    const readyBatch = await settlementService.processBatch(batch.id, { feeBps: 200 });

    // Step 17: Verify settlement calculations
    // Gross: ₹1,000.00 (100,000 minor)
    // Refunds: ₹300.00 (30,000 minor)
    // Fee: 2.0% of 100,000 = 2,000 minor (₹20.00)
    // Net: 100,000 - 30,000 - 2,000 = 68,000 minor (₹680.00)
    expect(readyBatch.grossAmountMinor).toBe(100000n);
    expect(readyBatch.refundAmountMinor).toBe(30000n);
    expect(readyBatch.feeAmountMinor).toBe(2000n);
    expect(readyBatch.netAmountMinor).toBe(68000n);
    expect(readyBatch.recordCount).toBe(1);

    // Step 18: Verify ledger balance on settlement execution
    const settledBatch = await settlementService.executeSettlement(batch.id);
    expect(settledBatch.status).toBe('SETTLED');
    expect(settledBatch.ledgerTransactionId).toBeDefined();

    const settleLedgerTx = await ledgerRepo.findTransactionById(settledBatch.ledgerTransactionId!);
    expect(settleLedgerTx).toBeDefined();
    expect(settleLedgerTx?.transactionType).toBe('SETTLEMENT');
    expect(settleLedgerTx?.referenceType).toBe('SETTLEMENT');
    expect(settleLedgerTx?.referenceId).toBe(batch.id);

    const settleDebit = settleLedgerTx?.entries.find((e) => e.entryType === 'DEBIT');
    const settleCredit = settleLedgerTx?.entries.find((e) => e.entryType === 'CREDIT');
    expect(settleDebit?.amountMinor).toBe(68000n);
    expect(settleCredit?.amountMinor).toBe(68000n);
    expect(settleDebit?.amountMinor).toBe(settleCredit?.amountMinor);

    // Step 19: Verify dashboard displays the complete lifecycle
    const metricsRes = await supertest(app).get('/api/v1/dashboard/metrics');
    expect(metricsRes.status).toBe(200);

    const settlementReportRes = await supertest(app).get(`/api/v1/settlements/${batch.id}/report`);
    expect(settlementReportRes.status).toBe(200);
    expect(settlementReportRes.body.data.amounts.netMinor).toBe(68000);
  });
});
