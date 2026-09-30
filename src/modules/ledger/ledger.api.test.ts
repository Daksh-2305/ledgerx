import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../server.js';
import { InMemoryPaymentRepository } from '../payments/payment.repository.js';
import { InMemoryLedgerRepository } from './ledger.repository.js';
import { LedgerService } from './ledger.service.js';
import {
  createPaymentContainer,
  setPaymentContainer,
  seedDemoData,
} from '../payments/payment.container.js';
import {
  createLedgerContainer,
  setLedgerContainer,
  seedDemoLedgerAccounts,
} from './ledger.container.js';

describe('Ledger API & Payment-Ledger Transaction Integration', () => {
  let app: ReturnType<typeof createServer>;
  let paymentRepo: InMemoryPaymentRepository;
  let ledgerRepo: InMemoryLedgerRepository;
  let ledgerService: LedgerService;

  const merchantId = '00000000-0000-0000-0000-000000000001';
  const customerId = '00000000-0000-0000-0000-000000000010';

  beforeEach(async () => {
    // 1. Setup isolated in-memory repositories
    paymentRepo = new InMemoryPaymentRepository();
    ledgerRepo = new InMemoryLedgerRepository();

    await seedDemoData(paymentRepo);
    await seedDemoLedgerAccounts(ledgerRepo);

    ledgerService = new LedgerService(ledgerRepo);

    // 2. Wire dependencies
    const ledgerContainer = await createLedgerContainer(ledgerRepo);
    setLedgerContainer(ledgerContainer);

    const paymentContainer = await createPaymentContainer(paymentRepo, ledgerService);
    setPaymentContainer(paymentContainer);

    app = createServer();
  });

  describe('Payment Capture Transactional Ledger Posting', () => {
    it('creates a balanced double-entry transaction when payment is captured', async () => {
      // 1. Create, initiate, and authorize a payment of ₹500 (50000 paise)
      const createRes = await request(app).post('/api/v1/payments').send({
        merchant_id: merchantId,
        customer_id: customerId,
        amount_minor: 50000,
        currency: 'INR',
        description: 'Double-entry test order',
      });
      const paymentId = createRes.body.data.id;

      await request(app).post(`/api/v1/payments/${paymentId}/initiate`);
      await request(app).post(`/api/v1/payments/${paymentId}/authorize`);

      // 2. Capture the payment
      const capRes = await request(app).post(`/api/v1/payments/${paymentId}/capture`);
      expect(capRes.status).toBe(200);
      expect(capRes.body.data.status).toBe('CAPTURED');

      // 3. Verify ledger transaction was posted
      const txRes = await request(app)
        .get('/api/v1/ledger/transactions')
        .query({ referenceType: 'PAYMENT', referenceId: paymentId });

      expect(txRes.status).toBe(200);
      expect(txRes.body.data.length).toBe(1);

      const ledgerTx = txRes.body.data[0];
      expect(ledgerTx.transactionType).toBe('CAPTURE');
      expect(ledgerTx.currency).toBe('INR');
      expect(ledgerTx.entries.length).toBe(2);

      // Verify entries balance: 1 DEBIT ₹500, 1 CREDIT ₹500
      const debitEntry = ledgerTx.entries.find((e: { entryType: string }) => e.entryType === 'DEBIT');
      const creditEntry = ledgerTx.entries.find((e: { entryType: string }) => e.entryType === 'CREDIT');

      expect(debitEntry).toBeDefined();
      expect(creditEntry).toBeDefined();
      expect(debitEntry.amountMinor).toBe(50000);
      expect(creditEntry.amountMinor).toBe(50000);
    });

    it('creates exactly one ledger transaction even when concurrent captures are attempted', async () => {
      // 1. Setup payment in AUTHORIZED state
      const createRes = await request(app).post('/api/v1/payments').send({
        merchant_id: merchantId,
        customer_id: customerId,
        amount_minor: 75000,
        currency: 'INR',
      });
      const paymentId = createRes.body.data.id;
      await request(app).post(`/api/v1/payments/${paymentId}/initiate`);
      await request(app).post(`/api/v1/payments/${paymentId}/authorize`);

      // 2. Dispatch two simultaneous capture HTTP requests
      const [res1, res2] = await Promise.all([
        request(app).post(`/api/v1/payments/${paymentId}/capture`),
        request(app).post(`/api/v1/payments/${paymentId}/capture`),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]); // One succeeds (200), one fails with conflict (409)

      // 3. Verify that the ledger contains strictly ONE transaction and TWO entries
      const txRes = await request(app)
        .get('/api/v1/ledger/transactions')
        .query({ referenceType: 'PAYMENT', referenceId: paymentId });

      expect(txRes.status).toBe(200);
      expect(txRes.body.data.length).toBe(1);
      expect(txRes.body.data[0].entries.length).toBe(2);
    });
  });

  describe('Read-Only Ledger Endpoints', () => {
    it('GET /api/v1/ledger/accounts/:id returns account and calculated balance', async () => {
      // Create a capture to populate balances
      const createRes = await request(app).post('/api/v1/payments').send({
        merchant_id: merchantId,
        customer_id: customerId,
        amount_minor: 20000, // ₹200.00
        currency: 'INR',
      });
      const paymentId = createRes.body.data.id;
      await request(app).post(`/api/v1/payments/${paymentId}/initiate`);
      await request(app).post(`/api/v1/payments/${paymentId}/authorize`);
      await request(app).post(`/api/v1/payments/${paymentId}/capture`);

      // Find Merchant Settlement Receivable account
      const txRes = await request(app)
        .get('/api/v1/ledger/transactions')
        .query({ referenceType: 'PAYMENT', referenceId: paymentId });
      const debitEntry = txRes.body.data[0].entries.find((e: { entryType: string }) => e.entryType === 'DEBIT');

      // Fetch account details
      const accRes = await request(app).get(`/api/v1/ledger/accounts/${debitEntry.accountId}`);
      expect(accRes.status).toBe(200);
      expect(accRes.body.success).toBe(true);
      expect(accRes.body.data.accountId).toBe(debitEntry.accountId);
      expect(accRes.body.data.totalDebitsMinor).toBe(20000);
      expect(accRes.body.data.netBalanceMinor).toBe(20000);
    });

    it('GET /api/v1/ledger/accounts/:id/entries returns paginated entries', async () => {
      const createRes = await request(app).post('/api/v1/payments').send({
        merchant_id: merchantId,
        customer_id: customerId,
        amount_minor: 10000,
        currency: 'INR',
      });
      const paymentId = createRes.body.data.id;
      await request(app).post(`/api/v1/payments/${paymentId}/initiate`);
      await request(app).post(`/api/v1/payments/${paymentId}/authorize`);
      await request(app).post(`/api/v1/payments/${paymentId}/capture`);

      const txRes = await request(app)
        .get('/api/v1/ledger/transactions')
        .query({ referenceType: 'PAYMENT', referenceId: paymentId });
      const accountId = txRes.body.data[0].entries[0].accountId;

      const entriesRes = await request(app)
        .get(`/api/v1/ledger/accounts/${accountId}/entries`)
        .query({ page: 1, limit: 10 });

      expect(entriesRes.status).toBe(200);
      expect(entriesRes.body.data.length).toBeGreaterThanOrEqual(1);
      expect(entriesRes.body.pagination.total).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/v1/ledger/integrity returns system financial integrity status', async () => {
      const res = await request(app).get('/api/v1/ledger/integrity');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.healthy).toBe(true);
      expect(res.body.data.unbalanced_transactions).toBe(0);
      expect(res.body.data.orphan_entries).toBe(0);
      expect(res.body.data.duplicate_financial_references).toBe(0);
    });

    it('enforces immutability: rejects modifications or deletions to transactions', async () => {
      // Attempting PUT /api/v1/ledger/transactions/:id
      const putRes = await request(app)
        .put('/api/v1/ledger/transactions/00000000-0000-0000-0000-000000000001')
        .send({ description: 'Hacked' });
      expect(putRes.status).toBe(404);

      // Attempting DELETE /api/v1/ledger/transactions/:id
      const delRes = await request(app).delete(
        '/api/v1/ledger/transactions/00000000-0000-0000-0000-000000000001'
      );
      expect(delRes.status).toBe(404);
    });
  });
});
