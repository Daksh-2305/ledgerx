import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../server.js';
import { InMemoryPaymentRepository } from './payment.repository.js';
import {
  createPaymentContainer,
  setPaymentContainer,
  seedDemoData,
} from './payment.container.js';

describe('Payment API Endpoints (Milestone 2)', () => {
  let app: ReturnType<typeof createServer>;
  let repository: InMemoryPaymentRepository;

  const merchantId = '00000000-0000-0000-0000-000000000001';
  const customerId = '00000000-0000-0000-0000-000000000010';

  beforeEach(async () => {
    repository = new InMemoryPaymentRepository();
    await seedDemoData(repository);
    const container = await createPaymentContainer(repository);
    setPaymentContainer(container);
    app = createServer();
  });

  describe('POST /api/v1/payments', () => {
    it('creates a new payment intent with 201 Created', async () => {
      const payload = {
        merchant_id: merchantId,
        customer_id: customerId,
        amount_minor: 15000,
        currency: 'INR',
        description: 'Order #40921',
      };

      const res = await request(app)
        .post('/api/v1/payments')
        .set('x-correlation-id', 'test-create-corr')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.status).toBe('CREATED');
      expect(res.body.data.amount_minor).toBe(15000);
      expect(res.body.data.currency).toBe('INR');
      expect(res.headers['x-correlation-id']).toBe('test-create-corr');
    });

    it('returns 400 for invalid body schema', async () => {
      const res = await request(app)
        .post('/api/v1/payments')
        .send({
          merchant_id: 'not-a-uuid',
          amount_minor: -100,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/payments/:id', () => {
    it('retrieves complete payment details including merchant, customer, and audit history', async () => {
      // 1. Create a payment
      const createRes = await request(app)
        .post('/api/v1/payments')
        .send({
          merchant_id: merchantId,
          customer_id: customerId,
          amount_minor: 2500,
          currency: 'INR',
        });
      const paymentId = createRes.body.data.id;

      // 2. Retrieve payment
      const res = await request(app).get(`/api/v1/payments/${paymentId}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(paymentId);
      expect(res.body.data.merchant.business_name).toBe('Acme Payments India');
      expect(res.body.data.customer.name).toBe('Rahul Sharma');
      expect(res.body.data.audit_logs).toBeInstanceOf(Array);
      expect(res.body.data.audit_logs.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 404 for unknown payment ID', async () => {
      const res = await request(app).get('/api/v1/payments/99999999-9999-9999-9999-999999999999');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/payments', () => {
    it('returns paginated payment list with status and merchant filters', async () => {
      // Create 3 payments
      for (let i = 1; i <= 3; i++) {
        await request(app).post('/api/v1/payments').send({
          merchant_id: merchantId,
          customer_id: customerId,
          amount_minor: 1000 * i,
          currency: 'INR',
        });
      }

      const res = await request(app)
        .get('/api/v1/payments')
        .query({ merchant_id: merchantId, status: 'CREATED', page: 1, limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(2);
      expect(res.body.pagination.total).toBe(3);
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.totalPages).toBe(2);
      expect(res.body.pagination.hasNextPage).toBe(true);
    });
  });

  describe('State Machine Transitions via Endpoints', () => {
    it('transitions CREATED -> PENDING -> AUTHORIZED -> CAPTURED', async () => {
      const createRes = await request(app).post('/api/v1/payments').send({
        merchant_id: merchantId,
        customer_id: customerId,
        amount_minor: 8000,
        currency: 'USD',
      });
      const paymentId = createRes.body.data.id;

      // Initiate: CREATED -> PENDING
      const initRes = await request(app).post(`/api/v1/payments/${paymentId}/initiate`);
      expect(initRes.status).toBe(200);
      expect(initRes.body.data.status).toBe('PENDING');

      // Authorize: PENDING -> AUTHORIZED
      const authRes = await request(app).post(`/api/v1/payments/${paymentId}/authorize`);
      expect(authRes.status).toBe(200);
      expect(authRes.body.data.status).toBe('AUTHORIZED');

      // Capture: AUTHORIZED -> CAPTURED
      const capRes = await request(app).post(`/api/v1/payments/${paymentId}/capture`);
      expect(capRes.status).toBe(200);
      expect(capRes.body.data.status).toBe('CAPTURED');
      expect(capRes.body.data.captured_amount_minor).toBe(8000);
    });

    it('rejects invalid state transition with 422 INVALID_PAYMENT_STATE', async () => {
      const createRes = await request(app).post('/api/v1/payments').send({
        merchant_id: merchantId,
        customer_id: customerId,
        amount_minor: 5000,
        currency: 'INR',
      });
      const paymentId = createRes.body.data.id;

      // Attempting to CAPTURE directly while in CREATED state (invalid transition)
      const res = await request(app).post(`/api/v1/payments/${paymentId}/capture`);

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_PAYMENT_STATE');
    });

    it('supports cancellation from PENDING state', async () => {
      const createRes = await request(app).post('/api/v1/payments').send({
        merchant_id: merchantId,
        customer_id: customerId,
        amount_minor: 5000,
        currency: 'INR',
      });
      const paymentId = createRes.body.data.id;

      await request(app).post(`/api/v1/payments/${paymentId}/initiate`);
      const cancelRes = await request(app).post(`/api/v1/payments/${paymentId}/cancel`);

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('CANCELLED');
    });
  });
});
