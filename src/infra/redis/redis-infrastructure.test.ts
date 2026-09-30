import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../server.js';
import {
  InMemoryRedisClient,
  checkRedisHealth,
  setRedisClient,
  resetRedisClient,
} from './redis.client.js';
import { RedisLockService } from './redis-lock.service.js';
import { RedisCacheService } from './redis-cache.service.js';
import { RedisRateLimiterService } from './redis-rate-limiter.service.js';
import { redisMetrics } from './redis.metrics.js';
import {
  createPaymentContainer,
  setPaymentContainer,
  seedDemoData,
} from '../../modules/payments/payment.container.js';
import { PaymentService } from '../../modules/payments/payment.service.js';
import { InMemoryPaymentRepository } from '../../modules/payments/payment.repository.js';
import {
  createLedgerContainer,
  setLedgerContainer,
  seedDemoLedgerAccounts,
} from '../../modules/ledger/ledger.container.js';
import { InMemoryLedgerRepository } from '../../modules/ledger/ledger.repository.js';
import { resetIdempotencyService } from '../../common/idempotency/idempotency.service.js';

describe('Redis Infrastructure & Distributed Coordination (Milestone 5)', () => {
  let mockRedis: InMemoryRedisClient;
  let lockService: RedisLockService;
  let cacheService: RedisCacheService;
  let rateLimiter: RedisRateLimiterService;

  beforeEach(() => {
    resetRedisClient();
    mockRedis = new InMemoryRedisClient();
    setRedisClient(mockRedis);
    lockService = new RedisLockService(async () => mockRedis);
    cacheService = new RedisCacheService(async () => mockRedis);
    rateLimiter = new RedisRateLimiterService(async () => mockRedis);
    redisMetrics.reset();
  });

  describe('1. Redis Connection, Health & Lifecycle', () => {
    it('successfully connects, pings, and reports healthy status', async () => {
      const ping = await mockRedis.ping();
      expect(ping).toBe('PONG');

      const health = await checkRedisHealth();
      expect(health.connected).toBe(true);
      expect(health.error).toBeUndefined();
    });

    it('reports fallback/degraded status gracefully if Redis is unavailable', async () => {
      mockRedis.setAvailable(false);
      resetRedisClient();
      setRedisClient(mockRedis);

      const health = await checkRedisHealth();
      expect(health.connected).toBe(false);
      expect(health.error).toBeDefined();
    });

    it('exposes redis connection and metrics in /ready endpoint', async () => {
      const app = createServer();
      const res = await request(app).get('/ready');

      expect([200, 503]).toContain(res.status);
      expect(res.body.dependencies.redis).toBeDefined();
      expect(res.body.metrics.redis).toBeDefined();
      expect(res.body.metrics.redis.redis_connection_status).toBeDefined();
    });
  });

  describe('2. Distributed Rate Limiting', () => {
    it('allows requests within limit and decrements remaining counter', async () => {
      const id = 'merchant_rate_test_1';
      const limit = 5;
      const windowSec = 10;

      for (let i = 0; i < limit; i++) {
        const result = await rateLimiter.consume(id, limit, windowSec);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(limit - 1 - i);
      }
    });

    it('blocks requests exceeding limit and returns retry-after metadata', async () => {
      const id = 'merchant_rate_test_2';
      const limit = 3;
      const windowSec = 10;

      for (let i = 0; i < limit; i++) {
        await rateLimiter.consume(id, limit, windowSec);
      }

      // 4th request exceeds limit
      const blocked = await rateLimiter.consume(id, limit, windowSec);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

      // Verify metric recorded
      const snapshot = redisMetrics.getSnapshot();
      expect(snapshot.rate_limit_blocks).toBeGreaterThanOrEqual(1);
    });

    it('HTTP middleware returns 429 Too Many Requests with rate-limit headers', async () => {
      const app = createServer();
      const merchantId = 'rate-limit-http-merchant';

      // Rapidly issue requests until rate limit triggered
      let rateLimitedResponse: request.Response | null = null;
      for (let i = 0; i < 110; i++) {
        const res = await request(app)
          .get('/api/v1/payments')
          .set('x-merchant-id', merchantId);

        if (res.status === 429) {
          rateLimitedResponse = res;
          break;
        }
      }

      expect(rateLimitedResponse).not.toBeNull();
      expect(rateLimitedResponse?.status).toBe(429);
      expect(rateLimitedResponse?.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(rateLimitedResponse?.headers['retry-after']).toBeDefined();
      expect(rateLimitedResponse?.headers['x-ratelimit-limit']).toBeDefined();
      expect(rateLimitedResponse?.headers['x-ratelimit-remaining']).toBe('0');
    });
  });

  describe('3. Cache-Aside Pattern & Invalidation', () => {
    it('sets and gets cached items with TTL, updating hit/miss metrics', async () => {
      const cacheKey = 'ledgerx:cache:payment:test-pay-1';
      const data = { id: 'test-pay-1', amount_minor: 5000 };

      // Cache miss
      const miss = await cacheService.get(cacheKey);
      expect(miss).toBeNull();

      // Store in cache
      await cacheService.set(cacheKey, data, 60);

      // Cache hit
      const hit = await cacheService.get(cacheKey);
      expect(hit).toEqual(data);

      const metrics = redisMetrics.getSnapshot();
      expect(metrics.cache_misses).toBe(1);
      expect(metrics.cache_hits).toBe(1);
    });

    it('invalidates payment cache when status is updated', async () => {
      const paymentRepo = new InMemoryPaymentRepository();
      await seedDemoData(paymentRepo);
      const ledgerRepo = new InMemoryLedgerRepository();
      await seedDemoLedgerAccounts(ledgerRepo);
      const ledgerContainer = await createLedgerContainer(ledgerRepo);
      setLedgerContainer(ledgerContainer);

      const paymentService = new PaymentService(paymentRepo, ledgerContainer.service, cacheService, lockService);
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 10000,
        currency: 'INR',
      });

      // 1. First read populates cache
      const read1 = await paymentService.getPaymentById(payment.id);
      expect(read1.status).toBe('CREATED');

      // Verify it is cached in Redis
      const cachedDirect = await mockRedis.get(`ledgerx:cache:payment:${payment.id}`);
      expect(cachedDirect).not.toBeNull();

      // 2. Transition status CREATED -> PENDING
      await paymentService.initiatePayment(payment.id);

      // 3. Verify cache key was invalidated
      const cacheAfterTransition = await mockRedis.get(`ledgerx:cache:payment:${payment.id}`);
      expect(cacheAfterTransition).toBeNull();

      // 4. Next read queries database and populates fresh state
      const read2 = await paymentService.getPaymentById(payment.id);
      expect(read2.status).toBe('PENDING');
    });

    it('invalidates both payment cache and refunds cache when refund is executed', async () => {
      const paymentRepo = new InMemoryPaymentRepository();
      await seedDemoData(paymentRepo);
      const ledgerRepo = new InMemoryLedgerRepository();
      await seedDemoLedgerAccounts(ledgerRepo);
      const ledgerContainer = await createLedgerContainer(ledgerRepo);
      setLedgerContainer(ledgerContainer);

      const paymentService = new PaymentService(paymentRepo, ledgerContainer.service, cacheService, lockService);
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 10000,
        currency: 'INR',
      });

      await paymentService.initiatePayment(payment.id);
      await paymentService.authorizePayment(payment.id);
      await paymentService.capturePayment(payment.id);

      // Populate caches
      await paymentService.getPaymentById(payment.id);
      await paymentService.listPaymentRefunds(payment.id);

      // Execute refund
      await paymentService.refundPayment(payment.id, 3000, 'test refund');

      // Verify caches invalidated
      const paymentCache = await mockRedis.get(`ledgerx:cache:payment:${payment.id}`);
      const refundCache = await mockRedis.get(`ledgerx:cache:refunds:${payment.id}`);
      expect(paymentCache).toBeNull();
      expect(refundCache).toBeNull();
    });
  });

  describe('4. Distributed Locks (Ownership & TTL Expiration)', () => {
    it('acquires lock and prevents concurrent acquisition by another process', async () => {
      const resource = 'payment-concurrency-1';

      // Process A acquires lock
      const lockA = await lockService.acquireLock(resource, 5000);
      expect(lockA.acquired).toBe(true);
      expect(lockA.token).toBeDefined();

      // Process B attempts to acquire same resource
      const lockB = await lockService.acquireLock(resource, 5000);
      expect(lockB.acquired).toBe(false);

      // Process A releases lock
      const released = await lockA.release();
      expect(released).toBe(true);

      // Process B can now acquire
      const lockBRetry = await lockService.acquireLock(resource, 5000);
      expect(lockBRetry.acquired).toBe(true);
      await lockBRetry.release();
    });

    it('enforces lock ownership: Process B cannot release Process A lock', async () => {
      const resource = 'payment-ownership-test';

      const lockA = await lockService.acquireLock(resource, 5000);
      expect(lockA.acquired).toBe(true);

      // Process B attempts to release Process A's lock using a bogus token
      const maliciousRelease = await lockService.releaseLock(resource, 'bogus-token-xyz');
      expect(maliciousRelease).toBe(false);

      // Verify Process A still holds the lock
      const lockC = await lockService.acquireLock(resource, 5000);
      expect(lockC.acquired).toBe(false);

      // Process A properly releases with correct token
      await lockA.release();
    });

    it('expires automatically via TTL if process disappears', async () => {
      const resource = 'payment-ttl-test';

      // Acquire lock with short 50ms TTL
      const lockA = await lockService.acquireLock(resource, 50);
      expect(lockA.acquired).toBe(true);

      // Immediate attempt fails
      const lockB = await lockService.acquireLock(resource, 50);
      expect(lockB.acquired).toBe(false);

      // Wait 60ms for TTL expiration
      await new Promise((r) => setTimeout(r, 60));

      // Another process can now acquire without permanent deadlock
      const lockC = await lockService.acquireLock(resource, 5000);
      expect(lockC.acquired).toBe(true);
      await lockC.release();
    });
  });

  describe('5. Redis Failure Resilience & PostgreSQL Authoritativeness', () => {
    it('continues executing financial operations seamlessly when Redis fails', async () => {
      const paymentRepo = new InMemoryPaymentRepository();
      await seedDemoData(paymentRepo);
      const ledgerRepo = new InMemoryLedgerRepository();
      await seedDemoLedgerAccounts(ledgerRepo);
      const ledgerContainer = await createLedgerContainer(ledgerRepo);
      setLedgerContainer(ledgerContainer);

      // Simulate Redis being completely offline / throwing connection errors
      mockRedis.setAvailable(false);

      const paymentService = new PaymentService(paymentRepo, ledgerContainer.service, cacheService, lockService);

      // 1. Payment creation succeeds (PostgreSQL authoritative)
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 10000,
        currency: 'INR',
      });
      expect(payment.id).toBeDefined();

      // 2. Transitions succeed under PostgreSQL row locks
      await paymentService.initiatePayment(payment.id);
      await paymentService.authorizePayment(payment.id);
      await paymentService.capturePayment(payment.id);

      // 3. Payment read falls back seamlessly to database
      const details = await paymentService.getPaymentById(payment.id);
      expect(details.status).toBe('CAPTURED');
      expect(details.captured_amount_minor).toBe(10000);

      // 4. Refund executes and double-entry ledger remains balanced
      const refund = await paymentService.refundPayment(payment.id, 4000, 'fault-tolerance-refund');
      expect(refund.amount_minor).toBe(4000);
      expect(refund.status).toBe('COMPLETED');

      const integrity = await ledgerContainer.service.verifyLedgerIntegrity();
      expect(integrity.healthy).toBe(true);
      expect(integrity.unbalanced_transactions).toBe(0);
    });
  });
});
