import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../server.js';
import {
  createPaymentContainer,
  setPaymentContainer,
  seedDemoData,
  getPaymentContainer,
} from './payment.container.js';
import { InMemoryPaymentRepository } from './payment.repository.js';
import {
  createLedgerContainer,
  setLedgerContainer,
  seedDemoLedgerAccounts,
  getLedgerContainer,
} from '../ledger/ledger.container.js';
import { InMemoryLedgerRepository } from '../ledger/ledger.repository.js';
import { resetIdempotencyService } from '../../common/idempotency/idempotency.service.js';

describe('Refunds & Partial Refunds (Milestone 4)', () => {
  const app = createServer();
  const merchantId = '00000000-0000-0000-0000-000000000001';
  const customerId = '00000000-0000-0000-0000-000000000010';

  let paymentRepo: InMemoryPaymentRepository;
  let ledgerRepo: InMemoryLedgerRepository;

  beforeEach(async () => {
    paymentRepo = new InMemoryPaymentRepository();
    await seedDemoData(paymentRepo);

    ledgerRepo = new InMemoryLedgerRepository();
    await seedDemoLedgerAccounts(ledgerRepo);

    const ledgerContainer = await createLedgerContainer(ledgerRepo);
    setLedgerContainer(ledgerContainer);

    const paymentContainer = await createPaymentContainer(paymentRepo, ledgerContainer.service);
    setPaymentContainer(paymentContainer);

    resetIdempotencyService();
  });

  async function createAndCapturePayment(amountMinor: number = 10000): Promise<string> {
    const res = await request(app)
      .post('/api/v1/payments')
      .send({
        merchant_id: merchantId,
        customer_id: customerId,
        amount_minor: amountMinor,
        currency: 'INR',
        description: 'Test Payment for Refund',
      });
    const id = res.body.data.id;
    await request(app).post(`/api/v1/payments/${id}/initiate`).send();
    await request(app).post(`/api/v1/payments/${id}/authorize`).send();
    await request(app).post(`/api/v1/payments/${id}/capture`).send();
    return id;
  }

  describe('1. Full Refund', () => {
    it('successfully executes a full refund and transitions status to REFUNDED', async () => {
      const paymentId = await createAndCapturePayment(10000);

      const res = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({
          amount_minor: 10000,
          reason: 'customer_request',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.amount_minor).toBe(10000);
      expect(res.body.data.status).toBe('COMPLETED');
      expect(res.body.data.payment_id).toBe(paymentId);

      // Verify payment status updated to REFUNDED
      const paymentRes = await request(app).get(`/api/v1/payments/${paymentId}`);
      expect(paymentRes.body.data.status).toBe('REFUNDED');
      expect(paymentRes.body.data.captured_amount_minor).toBe(10000);
      expect(paymentRes.body.data.refunded_amount_minor).toBe(10000);

      // Verify Double-Entry Ledger compensating transaction
      const ledgerContainer = await getLedgerContainer();
      const integrity = await ledgerContainer.service.verifyLedgerIntegrity();
      expect(integrity.healthy).toBe(true);
      expect(integrity.unbalanced_transactions).toBe(0);

      const refundTx = await ledgerContainer.repository.findTransactionByReference('REFUND', res.body.data.id);
      expect(refundTx).toBeDefined();
      expect(refundTx?.transactionType).toBe('REFUND');
      expect(refundTx?.entries.length).toBe(2);

      const clearingEntry = refundTx?.entries.find((e) => e.entryType === 'DEBIT');
      const merchantEntry = refundTx?.entries.find((e) => e.entryType === 'CREDIT');
      expect(clearingEntry?.amountMinor).toBe(10000n);
      expect(merchantEntry?.amountMinor).toBe(10000n);
    });
  });

  describe('2. Partial Refund & Multiple Partial Refunds', () => {
    it('supports partial refunds and updates status to PARTIALLY_REFUNDED', async () => {
      const paymentId = await createAndCapturePayment(10000); // ₹100

      // First partial refund: ₹30 (3000 minor)
      const res1 = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({ amount_minor: 3000, reason: 'damaged_item' });

      expect(res1.status).toBe(201);
      expect(res1.body.data.amount_minor).toBe(3000);
      expect(res1.body.data.status).toBe('COMPLETED');

      // Check payment status
      const p1 = await request(app).get(`/api/v1/payments/${paymentId}`);
      expect(p1.body.data.status).toBe('PARTIALLY_REFUNDED');
      expect(p1.body.data.captured_amount_minor).toBe(10000);
      expect(p1.body.data.refunded_amount_minor).toBe(3000);

      // Second partial refund: ₹20 (2000 minor)
      const res2 = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({ amount_minor: 2000, reason: 'partial_return' });

      expect(res2.status).toBe(201);
      expect(res2.body.data.amount_minor).toBe(2000);

      // Check payment status after second refund
      const p2 = await request(app).get(`/api/v1/payments/${paymentId}`);
      expect(p2.body.data.status).toBe('PARTIALLY_REFUNDED');
      expect(p2.body.data.refunded_amount_minor).toBe(5000);

      // Third refund for the remaining ₹50 (5000 minor) -> reaches full refund
      const res3 = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({ amount_minor: 5000, reason: 'final_balance' });

      expect(res3.status).toBe(201);

      const p3 = await request(app).get(`/api/v1/payments/${paymentId}`);
      expect(p3.body.data.status).toBe('REFUNDED');
      expect(p3.body.data.refunded_amount_minor).toBe(10000);
    });
  });

  describe('3. Over-Refunding Prevention', () => {
    it('strictly rejects refund amount greater than captured amount with 422 REFUND_AMOUNT_EXCEEDED', async () => {
      const paymentId = await createAndCapturePayment(10000); // ₹100

      const res = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({ amount_minor: 12000 }); // ₹120 > ₹100

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('REFUND_AMOUNT_EXCEEDED');

      // Payment balance must remain unmutated
      const paymentRes = await request(app).get(`/api/v1/payments/${paymentId}`);
      expect(paymentRes.body.data.status).toBe('CAPTURED');
      expect(paymentRes.body.data.refunded_amount_minor).toBe(0);
    });

    it('rejects refund after payment is already fully refunded', async () => {
      const paymentId = await createAndCapturePayment(5000);

      // Full refund
      await request(app).post(`/api/v1/payments/${paymentId}/refund`).send({ amount_minor: 5000 });

      // Attempt refund again
      const res = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({ amount_minor: 100 });

      expect(res.status).toBe(422);
    });

    it('rejects partial refund exceeding remaining refundable balance', async () => {
      const paymentId = await createAndCapturePayment(10000);

      // Refund ₹80
      await request(app).post(`/api/v1/payments/${paymentId}/refund`).send({ amount_minor: 8000 });

      // Attempt to refund ₹30 (80 + 30 = 110 > 100)
      const res = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({ amount_minor: 3000 });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('REFUND_AMOUNT_EXCEEDED');
    });
  });

  describe('4. Refund of Non-Captured Payments', () => {
    it('rejects refund for CREATED, PENDING, or AUTHORIZED payments', async () => {
      const res = await request(app)
        .post('/api/v1/payments')
        .send({
          merchant_id: merchantId,
          customer_id: customerId,
          amount_minor: 5000,
          currency: 'INR',
        });
      const paymentId = res.body.data.id;

      // Status: CREATED
      const refCreated = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({ amount_minor: 5000 });
      expect(refCreated.status).toBe(422);
      expect(refCreated.body.error.code).toBe('INVALID_PAYMENT_STATE');

      // Status: PENDING
      await request(app).post(`/api/v1/payments/${paymentId}/initiate`).send();
      const refPending = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({ amount_minor: 5000 });
      expect(refPending.status).toBe(422);

      // Status: AUTHORIZED
      await request(app).post(`/api/v1/payments/${paymentId}/authorize`).send();
      const refAuth = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({ amount_minor: 5000 });
      expect(refAuth.status).toBe(422);
    });
  });

  describe('5. Refund Concurrency Race Protection', () => {
    it('prevents concurrent race conditions from over-refunding a payment', async () => {
      const paymentId = await createAndCapturePayment(10000); // ₹100 captured

      // Two concurrent refund requests of ₹70 each arrive at the exact same time
      const [res1, res2] = await Promise.all([
        request(app).post(`/api/v1/payments/${paymentId}/refund`).send({ amount_minor: 7000 }),
        request(app).post(`/api/v1/payments/${paymentId}/refund`).send({ amount_minor: 7000 }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      // Exactly one must succeed (201) and the other must fail (422 REFUND_AMOUNT_EXCEEDED)
      expect(statuses).toEqual([201, 422]);

      const failedRes = res1.status === 422 ? res1 : res2;
      expect(failedRes.body.error.code).toBe('REFUND_AMOUNT_EXCEEDED');

      // Authoritative balance verification: total refunded must strictly be 7000 <= 10000
      const paymentRes = await request(app).get(`/api/v1/payments/${paymentId}`);
      expect(paymentRes.body.data.refunded_amount_minor).toBe(7000);
      expect(paymentRes.body.data.status).toBe('PARTIALLY_REFUNDED');

      // Double-entry integrity check
      const ledgerContainer = await getLedgerContainer();
      const integrity = await ledgerContainer.service.verifyLedgerIntegrity();
      expect(integrity.healthy).toBe(true);
      expect(integrity.unbalanced_transactions).toBe(0);
    });
  });

  describe('6. Idempotent Refund Replay', () => {
    it('replays completed refund response when retried with same Idempotency-Key', async () => {
      const paymentId = await createAndCapturePayment(10000);
      const idempotencyKey = 'refund-idemp-101';

      // 1. Initial refund
      const res1 = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ amount_minor: 4000, reason: 'customer return' });

      expect(res1.status).toBe(201);
      const refundId = res1.body.data.id;

      // 2. Retry with same Idempotency-Key
      const res2 = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ amount_minor: 4000, reason: 'customer return' });

      expect(res2.status).toBe(201);
      expect(res2.headers['x-idempotency-replayed']).toBe('true');
      expect(res2.body.data.id).toBe(refundId);
      expect(res2.body.data.amount_minor).toBe(4000);

      // Verify ONLY ONE refund record was created
      const listRefunds = await request(app).get(`/api/v1/payments/${paymentId}/refunds`);
      expect(listRefunds.status).toBe(200);
      expect(listRefunds.body.data.length).toBe(1);

      // Verify payment refunded amount is strictly 4000, NOT 8000
      const paymentRes = await request(app).get(`/api/v1/payments/${paymentId}`);
      expect(paymentRes.body.data.refunded_amount_minor).toBe(4000);
    });
  });

  describe('7. Refund Retrieval Endpoints', () => {
    it('fetches refund by ID via GET /api/v1/refunds/:id', async () => {
      const paymentId = await createAndCapturePayment(10000);
      const refundRes = await request(app)
        .post(`/api/v1/payments/${paymentId}/refund`)
        .send({ amount_minor: 2500, reason: 'test reason' });

      const refundId = refundRes.body.data.id;

      const getRes = await request(app).get(`/api/v1/refunds/${refundId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.id).toBe(refundId);
      expect(getRes.body.data.amount_minor).toBe(2500);
      expect(getRes.body.data.reason).toBe('test reason');
      expect(getRes.body.data.status).toBe('COMPLETED');
    });

    it('lists paginated refunds for payment via GET /api/v1/payments/:id/refunds', async () => {
      const paymentId = await createAndCapturePayment(10000);
      await request(app).post(`/api/v1/payments/${paymentId}/refund`).send({ amount_minor: 1000 });
      await request(app).post(`/api/v1/payments/${paymentId}/refund`).send({ amount_minor: 2000 });

      const listRes = await request(app).get(`/api/v1/payments/${paymentId}/refunds?page=1&limit=10`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.length).toBe(2);
      expect(listRes.body.pagination.total).toBe(2);
    });
  });
});
