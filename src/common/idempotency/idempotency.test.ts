import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../server.js';
import {
  createPaymentContainer,
  setPaymentContainer,
  seedDemoData,
} from '../../modules/payments/payment.container.js';
import { InMemoryPaymentRepository } from '../../modules/payments/payment.repository.js';
import {
  IdempotencyService,
  InMemoryIdempotencyRepository,
  setIdempotencyService,
  resetIdempotencyService,
} from './idempotency.service.js';
import { computeRequestHash } from './idempotency.types.js';
import {
  IdempotencyConflictError,
  IdempotencyKeyReusedError,
} from '../errors.js';

describe('Idempotency Service & Protocol (Milestone 4)', () => {
  let idempotencyRepo: InMemoryIdempotencyRepository;
  let service: IdempotencyService;

  beforeEach(async () => {
    idempotencyRepo = new InMemoryIdempotencyRepository();
    service = new IdempotencyService(idempotencyRepo);
    setIdempotencyService(service);

    const paymentRepo = new InMemoryPaymentRepository();
    await seedDemoData(paymentRepo);
    const paymentContainer = await createPaymentContainer(paymentRepo);
    setPaymentContainer(paymentContainer);
  });

  describe('Deterministic Request Hashing', () => {
    it('computes identical SHA-256 hashes regardless of JSON key ordering', () => {
      const payloadA = { amount_minor: 10000, currency: 'INR', description: 'Order #1' };
      const payloadB = { description: 'Order #1', currency: 'INR', amount_minor: 10000 };

      const hashA = computeRequestHash('POST', '/api/v1/payments', payloadA);
      const hashB = computeRequestHash('POST', '/api/v1/payments', payloadB);

      expect(hashA).toBe(hashB);
      expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    });

    it('computes different hashes for different payloads', () => {
      const payloadA = { amount_minor: 10000, currency: 'INR' };
      const payloadB = { amount_minor: 20000, currency: 'INR' };

      const hashA = computeRequestHash('POST', '/api/v1/payments', payloadA);
      const hashB = computeRequestHash('POST', '/api/v1/payments', payloadB);

      expect(hashA).not.toBe(hashB);
    });
  });

  describe('Core Idempotency State Transitions', () => {
    it('1. Same request + same key returns stored completed result', async () => {
      const key = 'idem-test-1';
      const body = { amount_minor: 5000, currency: 'INR' };

      const first = await service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body);
      expect(first.isNew).toBe(true);

      // Complete the operation
      await service.markCompleted(key, 201, { id: 'pay_123', status: 'CREATED' });

      // Second request
      const second = await service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body);
      expect(second.isNew).toBe(false);
      expect(second.responseStatus).toBe(201);
      expect(second.responseBody).toEqual({ id: 'pay_123', status: 'CREATED' });
    });

    it('2. Same request + repeated retries replays response without modifying state', async () => {
      const key = 'idem-test-retries';
      const body = { amount_minor: 7500, currency: 'USD' };

      await service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body);
      await service.markCompleted(key, 201, { id: 'pay_456' });

      for (let i = 0; i < 5; i++) {
        const retry = await service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body);
        expect(retry.isNew).toBe(false);
        expect(retry.responseStatus).toBe(201);
        expect(retry.responseBody).toEqual({ id: 'pay_456' });
      }
    });

    it('3. Same key + different payload is strictly rejected with IDEMPOTENCY_KEY_REUSED', async () => {
      const key = 'idem-test-reuse';
      const body1 = { amount_minor: 10000, currency: 'INR' };
      const body2 = { amount_minor: 20000, currency: 'INR' };

      await service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body1);
      await service.markCompleted(key, 201, { id: 'pay_100' });

      await expect(
        service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body2)
      ).rejects.toThrow(IdempotencyKeyReusedError);
    });

    it('4. Concurrent requests with same key detect conflict (IDEMPOTENCY_CONFLICT)', async () => {
      const key = 'idem-concurrent-test';
      const body = { amount_minor: 3000, currency: 'INR' };

      // Simulate simultaneous requests where first acquired lock and is IN_PROGRESS
      const req1 = await service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body);
      expect(req1.isNew).toBe(true);

      // Concurrent second request arrives while first is still IN_PROGRESS
      await expect(
        service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body)
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it('5. Failed request allows safe retry after rollback', async () => {
      const key = 'idem-fail-retry';
      const body = { amount_minor: 4000, currency: 'EUR' };

      const attempt1 = await service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body);
      expect(attempt1.isNew).toBe(true);

      // Transaction failed, mark failed
      await service.markFailed(key);

      // Retry after failure must be allowed
      const attempt2 = await service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body);
      expect(attempt2.isNew).toBe(true);
      await service.markCompleted(key, 201, { id: 'pay_recovered' });

      const finalCheck = await service.processOrLookup(key, 'merchant-1', 'POST', '/payments', body);
      expect(finalCheck.isNew).toBe(false);
      expect(finalCheck.responseBody).toEqual({ id: 'pay_recovered' });
    });
  });

  describe('HTTP Layer Middleware Integration', () => {
    it('replays identical HTTP response with x-idempotency-replayed header on retry', async () => {
      const app = createServer();
      const idemKey = 'http-idem-test-1';

      const payload = {
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 15000,
        currency: 'INR',
        description: 'Test Idempotent Payment',
      };

      // 1. Initial Request
      const res1 = await request(app)
        .post('/api/v1/payments')
        .set('Idempotency-Key', idemKey)
        .send(payload);

      expect(res1.status).toBe(201);
      expect(res1.headers['x-idempotency-replayed']).toBeUndefined();
      const paymentId = res1.body.data.id;
      expect(paymentId).toBeDefined();

      // 2. Retry identical Request with same Idempotency-Key
      const res2 = await request(app)
        .post('/api/v1/payments')
        .set('Idempotency-Key', idemKey)
        .send(payload);

      expect(res2.status).toBe(201);
      expect(res2.headers['x-idempotency-replayed']).toBe('true');
      expect(res2.body.data.id).toBe(paymentId);
      expect(res2.body.data.amount_minor).toBe(15000);

      // 3. Verify in database: exactly ONE payment exists
      const listRes = await request(app).get('/api/v1/payments');
      const matchingPayments = listRes.body.data.filter((p: { id: string }) => p.id === paymentId);
      expect(matchingPayments.length).toBe(1);
    });

    it('rejects HTTP request when same Idempotency-Key is reused with different payload (409 IDEMPOTENCY_KEY_REUSED)', async () => {
      const app = createServer();
      const idemKey = 'http-idem-mismatch-key';

      const payload1 = {
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 10000,
        currency: 'INR',
      };

      const payload2 = {
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 25000, // Different amount!
        currency: 'INR',
      };

      const res1 = await request(app)
        .post('/api/v1/payments')
        .set('Idempotency-Key', idemKey)
        .send(payload1);

      expect(res1.status).toBe(201);

      // Reused key with different payload
      const res2 = await request(app)
        .post('/api/v1/payments')
        .set('Idempotency-Key', idemKey)
        .send(payload2);

      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });
});
