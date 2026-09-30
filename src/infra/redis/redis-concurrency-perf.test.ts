import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../server.js';
import {
  InMemoryRedisClient,
  setRedisClient,
  resetRedisClient,
} from './redis.client.js';
import { RedisLockService } from './redis-lock.service.js';
import { RedisCacheService } from './redis-cache.service.js';
import { redisMetrics } from './redis.metrics.js';
import {
  createPaymentContainer,
  setPaymentContainer,
  seedDemoData,
} from '../../modules/payments/payment.container.js';
import { InMemoryPaymentRepository } from '../../modules/payments/payment.repository.js';
import {
  createLedgerContainer,
  setLedgerContainer,
  seedDemoLedgerAccounts,
} from '../../modules/ledger/ledger.container.js';
import { InMemoryLedgerRepository } from '../../modules/ledger/ledger.repository.js';
import { PaymentService } from '../../modules/payments/payment.service.js';

describe('Redis Concurrency & Performance Benchmarks (Milestone 5)', () => {
  let mockRedis: InMemoryRedisClient;
  let lockService: RedisLockService;
  let cacheService: RedisCacheService;

  beforeEach(() => {
    resetRedisClient();
    mockRedis = new InMemoryRedisClient();
    setRedisClient(mockRedis);
    lockService = new RedisLockService(async () => mockRedis);
    cacheService = new RedisCacheService(async () => mockRedis);
    redisMetrics.reset();
  });

  describe('Section 17: Realistic Concurrency Stress (20 Concurrent Refunds)', () => {
    it('handles 20 concurrent refund requests: total refunds never exceed captured amount and ledger balances', async () => {
      const paymentRepo = new InMemoryPaymentRepository();
      await seedDemoData(paymentRepo);
      const ledgerRepo = new InMemoryLedgerRepository();
      await seedDemoLedgerAccounts(ledgerRepo);
      const ledgerContainer = await createLedgerContainer(ledgerRepo);
      setLedgerContainer(ledgerContainer);

      const paymentService = new PaymentService(
        paymentRepo,
        ledgerContainer.service,
        cacheService,
        lockService
      );

      // Create and capture a payment of ₹100 (10000 minor units)
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 10000,
        currency: 'INR',
      });
      await paymentService.initiatePayment(payment.id);
      await paymentService.authorizePayment(payment.id);
      await paymentService.capturePayment(payment.id);

      // Launch 20 concurrent refund requests of ₹10 (1000 minor units) each
      // Total attempted: 20 * 1000 = 20000 minor units (2x the captured amount!)
      const concurrentRequests = Array.from({ length: 20 }, (_, idx) =>
        paymentService
          .refundPayment(payment.id, 1000, `Concurrent refund batch #${idx + 1}`)
          .then((res) => ({ success: true, refund: res }))
          .catch((err) => ({ success: false, error: err }))
      );

      const results = await Promise.all(concurrentRequests);

      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      // Exactly 10 can succeed (10 * 1000 = 10000)
      // Exactly 10 must fail with REFUND_AMOUNT_EXCEEDED
      expect(successful.length).toBe(10);
      expect(failed.length).toBe(10);

      for (const f of failed) {
        expect(f.error?.errorCode || f.error?.name).toMatch(
          /REFUND_AMOUNT_EXCEEDED|RefundAmountExceededError|INVALID_PAYMENT_STATE/
        );
      }

      // Verify authoritative database balance
      const finalPayment = await paymentRepo.findPaymentById(payment.id);
      expect(finalPayment?.refundedAmountMinor).toBe(10000n);
      expect(finalPayment?.status).toBe('REFUNDED');

      // Verify Double-Entry Ledger integrity: 100% balanced
      const integrity = await ledgerContainer.service.verifyLedgerIntegrity();
      expect(integrity.healthy).toBe(true);
      expect(integrity.unbalanced_transactions).toBe(0);
      expect(integrity.duplicate_financial_references).toBe(0);
    });
  });

  describe('Section 18: Performance Benchmark (Cache Disabled vs Cache Enabled)', () => {
    it('compares read latencies and hit rates between cache-disabled and cache-enabled reads', async () => {
      const paymentRepo = new InMemoryPaymentRepository();
      await seedDemoData(paymentRepo);
      const ledgerRepo = new InMemoryLedgerRepository();
      await seedDemoLedgerAccounts(ledgerRepo);
      const ledgerContainer = await createLedgerContainer(ledgerRepo);
      setLedgerContainer(ledgerContainer);

      const paymentService = new PaymentService(
        paymentRepo,
        ledgerContainer.service,
        cacheService,
        lockService
      );

      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 50000,
        currency: 'INR',
      });

      const iterations = 50;

      // 1. Benchmark: Cache Disabled (Direct database reads)
      const latenciesNoCache: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await paymentRepo.findPaymentWithDetails(payment.id);
        latenciesNoCache.push(performance.now() - start);
      }

      // 2. Benchmark: Cache Enabled (Cache-aside via PaymentService)
      // First read to prime cache
      await paymentService.getPaymentById(payment.id);

      const latenciesWithCache: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await paymentService.getPaymentById(payment.id);
        latenciesWithCache.push(performance.now() - start);
      }

      const avgNoCache = latenciesNoCache.reduce((a, b) => a + b, 0) / iterations;
      const avgWithCache = latenciesWithCache.reduce((a, b) => a + b, 0) / iterations;

      const p95NoCache = [...latenciesNoCache].sort((a, b) => a - b)[Math.floor(iterations * 0.95)];
      const p95WithCache = [...latenciesWithCache].sort((a, b) => a - b)[Math.floor(iterations * 0.95)];

      const metrics = redisMetrics.getSnapshot();
      const totalCacheRequests = metrics.cache_hits + metrics.cache_misses;
      const hitRate = totalCacheRequests > 0 ? (metrics.cache_hits / totalCacheRequests) * 100 : 0;

      // Assert metrics and operational validity
      expect(metrics.cache_hits).toBeGreaterThanOrEqual(iterations);
      expect(hitRate).toBeGreaterThan(95);

      // Log architectural performance findings for telemetry report
      // eslint-disable-next-line no-console
      console.log(`\n--- Milestone 5 Performance Benchmark ---`);
      // eslint-disable-next-line no-console
      console.log(`Requests: ${iterations} reads`);
      // eslint-disable-next-line no-console
      console.log(`Direct Database Read Avg: ${avgNoCache.toFixed(3)} ms | p95: ${p95NoCache.toFixed(3)} ms`);
      // eslint-disable-next-line no-console
      console.log(`Redis Cache-Aside Avg: ${avgWithCache.toFixed(3)} ms | p95: ${p95WithCache.toFixed(3)} ms`);
      // eslint-disable-next-line no-console
      console.log(`Cache Hit Rate: ${hitRate.toFixed(1)}%\n`);
    });
  });
});
