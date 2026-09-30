import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../server.js';
import { config } from '../../config/index.js';
import { InMemoryRedisClient, setRedisClient, resetRedisClient } from '../../infra/redis/redis.client.js';
import { InMemoryKafkaClient, setKafkaClient, resetKafkaClient } from '../../infra/kafka/kafka.client.js';
import { KafkaProducerService } from '../../infra/kafka/kafka-producer.js';
import { InMemoryProcessedEventsRepository } from '../../infra/kafka/kafka-consumer.js';
import {
  HighPaymentAmountRule,
  PaymentVelocityRule,
  RepeatedPaymentFailuresRule,
  RapidTransactionBurstRule,
  HighRefundVelocityRule,
  recordPaymentFailureSignal,
  recordRefundSignal,
} from './risk.rules.js';
import { InMemoryRiskRepository } from './risk.repository.js';
import { RiskService } from './risk.service.js';
import { RiskController } from './risk.controller.js';
import { RiskEngineConsumer } from './risk-consumer.service.js';
import { setRiskContainer, resetRiskContainer } from './risk.container.js';
import { PaymentRiskDecisionConsumer } from '../payments/payment-risk-consumer.js';
import { InMemoryPaymentRepository } from '../payments/payment.repository.js';
import { InMemoryLedgerRepository } from '../ledger/ledger.repository.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { createEventEnvelope, DomainEventTypes, KafkaTopics } from '../../infra/kafka/event-envelope.js';
import { RiskRuleContext, IRiskRule, RiskRuleResult } from './risk.types.js';

describe('Transaction Risk Engine (Milestone 8)', () => {
  let app: ReturnType<typeof createServer>;
  let redisClient: InMemoryRedisClient;
  let kafkaClient: InMemoryKafkaClient;
  let kafkaProducer: KafkaProducerService;
  let riskRepo: InMemoryRiskRepository;
  let riskService: RiskService;
  let riskConsumer: RiskEngineConsumer;
  let processedRepo: InMemoryProcessedEventsRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let ledgerRepo: InMemoryLedgerRepository;
  let ledgerService: LedgerService;
  let paymentService: PaymentService;
  let paymentRiskConsumer: PaymentRiskDecisionConsumer;

  const testMerchantId = 'merchant-test-001';
  const testCustomerId = 'customer-test-001';

  beforeEach(async () => {
    resetRedisClient();
    resetKafkaClient();
    resetRiskContainer();

    // 1. Setup in-memory Redis client
    redisClient = new InMemoryRedisClient();
    setRedisClient(redisClient);

    // 2. Setup in-memory Kafka client
    kafkaClient = new InMemoryKafkaClient();
    setKafkaClient(kafkaClient);
    kafkaProducer = new KafkaProducerService(async () => kafkaClient.producer());

    // 3. Setup repositories & services
    riskRepo = new InMemoryRiskRepository();
    riskService = new RiskService({
      repository: riskRepo,
      kafkaProducer,
      redisClient,
    });
    const riskController = new RiskController(riskService);

    processedRepo = new InMemoryProcessedEventsRepository();
    riskConsumer = new RiskEngineConsumer({
      riskService,
      processedRepo,
    });

    // 4. Financial services for integration verification
    paymentRepo = new InMemoryPaymentRepository();
    ledgerRepo = new InMemoryLedgerRepository();
    ledgerService = new LedgerService(ledgerRepo);
    paymentService = new PaymentService(paymentRepo, ledgerService);

    paymentRiskConsumer = new PaymentRiskDecisionConsumer({
      paymentService,
      processedRepo,
    });

    // 5. Register in DI container
    setRiskContainer({
      repository: riskRepo,
      service: riskService,
      controller: riskController,
      consumer: riskConsumer,
    });

    await riskConsumer.start();
    await paymentRiskConsumer.start();

    // 6. Build Express app
    app = createServer();
  });

  afterEach(async () => {
    await riskConsumer.stop();
    await paymentRiskConsumer.stop();
  });

  // ========================================================
  // Section 1: Modular Risk Rules Unit Tests
  // ========================================================
  describe('Modular Risk Rules', () => {
    describe('Rule 1: High Payment Amount', () => {
      const rule = new HighPaymentAmountRule(500000, 35);

      it('does not trigger when amount is strictly below threshold', async () => {
        const ctx: RiskRuleContext = {
          paymentId: 'pay-001',
          merchantId: testMerchantId,
          customerId: testCustomerId,
          amountMinor: 499999,
          currency: 'INR',
          now: new Date(),
          redis: redisClient,
        };
        const result = await rule.evaluate(ctx);
        expect(result.triggered).toBe(false);
        expect(result.score).toBe(0);
        expect(result.reason).toBeNull();
      });

      it('triggers when amount equals or exceeds threshold', async () => {
        const ctx: RiskRuleContext = {
          paymentId: 'pay-002',
          merchantId: testMerchantId,
          customerId: testCustomerId,
          amountMinor: 500000,
          currency: 'INR',
          now: new Date(),
          redis: redisClient,
        };
        const result = await rule.evaluate(ctx);
        expect(result.triggered).toBe(true);
        expect(result.score).toBe(35);
        expect(result.reason).toContain('exceeds threshold');
      });
    });

    describe('Rule 2: Payment Velocity', () => {
      // Threshold: 3 payments in 60s
      const rule = new PaymentVelocityRule(3, 60, 25);

      it('does not trigger when rate is below configured threshold', async () => {
        const now = new Date();
        const ctx: RiskRuleContext = {
          paymentId: 'pay-v1',
          merchantId: testMerchantId,
          customerId: testCustomerId,
          amountMinor: 5000,
          currency: 'INR',
          now,
          redis: redisClient,
        };

        const res1 = await rule.evaluate(ctx);
        expect(res1.triggered).toBe(false);

        const res2 = await rule.evaluate({ ...ctx, paymentId: 'pay-v2' });
        expect(res2.triggered).toBe(false);
      });

      it('triggers when velocity exceeds allowed rate', async () => {
        const now = new Date();
        const ctx: RiskRuleContext = {
          paymentId: 'pay-v1',
          merchantId: testMerchantId,
          customerId: testCustomerId,
          amountMinor: 5000,
          currency: 'INR',
          now,
          redis: redisClient,
        };

        await rule.evaluate(ctx);
        await rule.evaluate({ ...ctx, paymentId: 'pay-v2' });
        await rule.evaluate({ ...ctx, paymentId: 'pay-v3' });
        const res4 = await rule.evaluate({ ...ctx, paymentId: 'pay-v4' });

        expect(res4.triggered).toBe(true);
        expect(res4.score).toBe(25);
        expect(res4.reason).toContain('Payment velocity');
      });
    });

    describe('Rule 3: Repeated Failures', () => {
      // Threshold: 3 failures in 300s
      const rule = new RepeatedPaymentFailuresRule(3, 300, 20);

      it('does not trigger below failure threshold', async () => {
        const now = new Date();
        await recordPaymentFailureSignal(redisClient, testCustomerId, now, 300);

        const ctx: RiskRuleContext = {
          paymentId: 'pay-f1',
          merchantId: testMerchantId,
          customerId: testCustomerId,
          amountMinor: 5000,
          currency: 'INR',
          now,
          redis: redisClient,
        };

        const result = await rule.evaluate(ctx);
        expect(result.triggered).toBe(false);
        expect(result.score).toBe(0);
      });

      it('triggers when failed attempts exceed threshold', async () => {
        const now = new Date();
        await recordPaymentFailureSignal(redisClient, testCustomerId, now, 300);
        await recordPaymentFailureSignal(redisClient, testCustomerId, now, 300);
        await recordPaymentFailureSignal(redisClient, testCustomerId, now, 300);

        const ctx: RiskRuleContext = {
          paymentId: 'pay-f2',
          merchantId: testMerchantId,
          customerId: testCustomerId,
          amountMinor: 5000,
          currency: 'INR',
          now,
          redis: redisClient,
        };

        const result = await rule.evaluate(ctx);
        expect(result.triggered).toBe(true);
        expect(result.score).toBe(20);
        expect(result.reason).toContain('Repeated payment failures');
      });
    });

    describe('Rule 4: Rapid Repeated Payments (Burst)', () => {
      // Threshold: 3 burst payments in 10s
      const rule = new RapidTransactionBurstRule(3, 10, 15);

      it('does not trigger for spaced transactions', async () => {
        const ctx: RiskRuleContext = {
          paymentId: 'pay-b1',
          merchantId: testMerchantId,
          customerId: testCustomerId,
          amountMinor: 5000,
          currency: 'INR',
          now: new Date(),
          redis: redisClient,
        };

        const res1 = await rule.evaluate(ctx);
        expect(res1.triggered).toBe(false);
      });

      it('triggers when burst limit is exceeded within short window', async () => {
        const now = new Date();
        const ctx: RiskRuleContext = {
          paymentId: 'pay-b1',
          merchantId: testMerchantId,
          customerId: testCustomerId,
          amountMinor: 5000,
          currency: 'INR',
          now,
          redis: redisClient,
        };

        await rule.evaluate(ctx);
        await rule.evaluate({ ...ctx, paymentId: 'pay-b2' });
        await rule.evaluate({ ...ctx, paymentId: 'pay-b3' });
        const resBurst = await rule.evaluate({ ...ctx, paymentId: 'pay-b4' });

        expect(resBurst.triggered).toBe(true);
        expect(resBurst.score).toBe(15);
        expect(resBurst.reason).toContain('Rapid transaction burst');
      });
    });

    describe('Rule 5: Refund Velocity', () => {
      // Threshold: 2 refunds in 600s
      const rule = new HighRefundVelocityRule(2, 600, 10);

      it('does not trigger below refund velocity threshold', async () => {
        const now = new Date();
        await recordRefundSignal(redisClient, testMerchantId, now, 600);

        const ctx: RiskRuleContext = {
          paymentId: 'pay-r1',
          merchantId: testMerchantId,
          customerId: testCustomerId,
          amountMinor: 5000,
          currency: 'INR',
          now,
          redis: redisClient,
        };

        const result = await rule.evaluate(ctx);
        expect(result.triggered).toBe(false);
      });

      it('triggers when refund count exceeds threshold', async () => {
        const now = new Date();
        await recordRefundSignal(redisClient, testMerchantId, now, 600);
        await recordRefundSignal(redisClient, testMerchantId, now, 600);

        const ctx: RiskRuleContext = {
          paymentId: 'pay-r2',
          merchantId: testMerchantId,
          customerId: testCustomerId,
          amountMinor: 5000,
          currency: 'INR',
          now,
          redis: redisClient,
        };

        const result = await rule.evaluate(ctx);
        expect(result.triggered).toBe(true);
        expect(result.score).toBe(10);
        expect(result.reason).toContain('High refund velocity');
      });
    });
  });

  // ========================================================
  // Section 2: Score Calculation & Risk Level Boundaries
  // ========================================================
  describe('Scoring & Risk Level Boundaries', () => {
    it('calculates total score as sum of triggered rules and clamps between 0 and 100', async () => {
      // Test custom rule set exceeding 100
      class OverweightRule implements IRiskRule {
        public readonly ruleId = 'OVERWEIGHT_RULE';
        async evaluate(): Promise<RiskRuleResult> {
          return { ruleId: this.ruleId, triggered: true, score: 150, reason: 'Exceeding bounds' };
        }
      }

      const customService = new RiskService({
        repository: riskRepo,
        kafkaProducer,
        redisClient,
        rules: [new OverweightRule()],
      });

      const assessment = await customService.evaluatePayment({
        paymentId: 'pay-clamp-1',
        merchantId: testMerchantId,
        amountMinor: 1000,
        currency: 'INR',
      });

      expect(assessment.riskScore).toBe(100);
      expect(assessment.riskLevel).toBe('CRITICAL');
      expect(assessment.decision).toBe('BLOCK');
    });

    it('correctly maps all risk level boundary edges', () => {
      // 0-24 -> LOW
      expect(riskService.mapScoreToRiskLevel(0)).toBe('LOW');
      expect(riskService.mapScoreToRiskLevel(24)).toBe('LOW');

      // 25-49 -> MEDIUM
      expect(riskService.mapScoreToRiskLevel(25)).toBe('MEDIUM');
      expect(riskService.mapScoreToRiskLevel(49)).toBe('MEDIUM');

      // 50-74 -> HIGH
      expect(riskService.mapScoreToRiskLevel(50)).toBe('HIGH');
      expect(riskService.mapScoreToRiskLevel(74)).toBe('HIGH');

      // 75-100 -> CRITICAL
      expect(riskService.mapScoreToRiskLevel(75)).toBe('CRITICAL');
      expect(riskService.mapScoreToRiskLevel(100)).toBe('CRITICAL');
    });

    it('correctly maps decisions for each risk level', () => {
      expect(riskService.mapRiskLevelToDecision('LOW')).toBe('ALLOW');
      expect(riskService.mapRiskLevelToDecision('MEDIUM')).toBe('ALLOW');
      expect(riskService.mapRiskLevelToDecision('HIGH')).toBe('REVIEW');
      expect(riskService.mapRiskLevelToDecision('CRITICAL')).toBe('BLOCK');
    });
  });

  // ========================================================
  // Section 3: Consumer Idempotency (Duplicate Events)
  // ========================================================
  describe('Consumer Idempotency', () => {
    it('safely handles duplicate Kafka payment.created events without creating duplicate assessments', async () => {
      const eventEnvelope = createEventEnvelope({
        eventType: DomainEventTypes.PAYMENT_CREATED,
        aggregateId: 'pay-idempotent-001',
        payload: {
          id: 'pay-idempotent-001',
          merchant_id: testMerchantId,
          amount_minor: 15000,
          currency: 'INR',
          status: 'CREATED',
        },
      });

      // Deliver first time
      await riskConsumer.handleIncomingMessage({
        topic: KafkaTopics.PAYMENT_EVENTS,
        partition: 0,
        message: {
          offset: '101',
          key: 'pay-idempotent-001',
          value: JSON.stringify(eventEnvelope),
          timestamp: String(Date.now()),
        },
      });

      const initialAssessments = await riskRepo.list({ paymentId: 'pay-idempotent-001' });
      expect(initialAssessments.data.length).toBe(1);
      const firstAssessmentId = initialAssessments.data[0].id;

      // Deliver second time (exact duplicate Kafka event)
      await riskConsumer.handleIncomingMessage({
        topic: KafkaTopics.PAYMENT_EVENTS,
        partition: 0,
        message: {
          offset: '102',
          key: 'pay-idempotent-001',
          value: JSON.stringify(eventEnvelope),
          timestamp: String(Date.now()),
        },
      });

      const afterAssessments = await riskRepo.list({ paymentId: 'pay-idempotent-001' });
      expect(afterAssessments.data.length).toBe(1);
      expect(afterAssessments.data[0].id).toBe(firstAssessmentId);
    });
  });

  // ========================================================
  // Section 4: Redis Outage & Graceful Degradation
  // ========================================================
  describe('Redis Outage & Graceful Degradation', () => {
    it('does not crash or corrupt state when Redis is unavailable, marking evaluation as DEGRADED', async () => {
      // Simulate Redis downtime
      redisClient.setAvailable(false);

      const assessment = await riskService.evaluatePayment({
        paymentId: 'pay-redis-down',
        merchantId: testMerchantId,
        amountMinor: 600000, // triggers high amount rule regardless of Redis
        currency: 'INR',
      });

      expect(assessment.evaluationStatus).toBe('DEGRADED');
      // High amount rule evaluated successfully from database payload
      expect(assessment.riskScore).toBe(35);
      expect(assessment.riskLevel).toBe('MEDIUM');
      expect(assessment.decision).toBe('ALLOW');

      const saved = await riskRepo.findByPaymentId('pay-redis-down');
      expect(saved?.evaluationStatus).toBe('DEGRADED');
    });
  });

  // ========================================================
  // Section 5: Risk REST APIs (Read-Only)
  // ========================================================
  describe('Risk Engine REST APIs', () => {
    beforeEach(async () => {
      // Pre-seed three assessments with different levels
      await riskRepo.save({
        id: '00000000-0000-0000-0000-0000000000a1',
        paymentId: 'pay-api-low',
        riskScore: 10,
        riskLevel: 'LOW',
        decision: 'ALLOW',
        rulesTriggered: [],
        modelVersion: 'rules-v1',
        evaluationStatus: 'COMPLETED',
        evaluationDurationMs: 1.2,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await riskRepo.save({
        id: '00000000-0000-0000-0000-0000000000a2',
        paymentId: 'pay-api-high',
        riskScore: 60,
        riskLevel: 'HIGH',
        decision: 'REVIEW',
        rulesTriggered: [
          { ruleId: 'HIGH_PAYMENT_AMOUNT', score: 35, reason: 'High amount' },
          { ruleId: 'HIGH_PAYMENT_VELOCITY', score: 25, reason: 'Velocity' },
        ],
        modelVersion: 'rules-v1',
        evaluationStatus: 'COMPLETED',
        evaluationDurationMs: 2.1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await riskRepo.save({
        id: '00000000-0000-0000-0000-0000000000a3',
        paymentId: 'pay-api-crit',
        riskScore: 90,
        riskLevel: 'CRITICAL',
        decision: 'BLOCK',
        rulesTriggered: [
          { ruleId: 'HIGH_PAYMENT_AMOUNT', score: 35, reason: 'High amount' },
          { ruleId: 'HIGH_PAYMENT_VELOCITY', score: 25, reason: 'Velocity' },
          { ruleId: 'REPEATED_PAYMENT_FAILURES', score: 20, reason: 'Failures' },
          { ruleId: 'RAPID_TRANSACTION_BURST', score: 15, reason: 'Burst' },
        ],
        modelVersion: 'rules-v1',
        evaluationStatus: 'COMPLETED',
        evaluationDurationMs: 3.5,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    it('GET /api/v1/risk/payments/:paymentId returns risk assessment for valid payment', async () => {
      const res = await request(app).get('/api/v1/risk/payments/pay-api-high');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.riskScore).toBe(60);
      expect(res.body.data.riskLevel).toBe('HIGH');
      expect(res.body.data.decision).toBe('REVIEW');
      expect((res.body.data.rulesTriggered || res.body.data.triggeredRules).length).toBe(2);
    });

    it('GET /api/v1/risk/payments/:paymentId returns 404 for non-existent payment', async () => {
      const res = await request(app).get('/api/v1/risk/payments/non-existent-pay');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('GET /api/v1/risk/assessments/:id returns assessment by id', async () => {
      const res = await request(app).get('/api/v1/risk/assessments/00000000-0000-0000-0000-0000000000a3');
      expect(res.status).toBe(200);
      expect(res.body.data.decision).toBe('BLOCK');
      expect(res.body.data.riskScore).toBe(90);
    });

    it('GET /api/v1/risk/assessments supports filtering by risk_level, decision, and pagination', async () => {
      // 1. Filter by decision = BLOCK
      const resBlock = await request(app).get('/api/v1/risk/assessments?decision=BLOCK');
      expect(resBlock.status).toBe(200);
      expect(resBlock.body.data.length).toBe(1);
      expect(resBlock.body.data[0].paymentId).toBe('pay-api-crit');

      // 2. Filter by risk_level = LOW
      const resLow = await request(app).get('/api/v1/risk/assessments?risk_level=LOW');
      expect(resLow.status).toBe(200);
      expect(resLow.body.data.length).toBe(1);
      expect(resLow.body.data[0].paymentId).toBe('pay-api-low');

      // 3. Pagination limit = 2
      const resLimit = await request(app).get('/api/v1/risk/assessments?limit=2');
      expect(resLimit.status).toBe(200);
      expect(resLimit.body.data.length).toBe(2);
      expect(resLimit.body.pagination.total).toBe(3);
    });
  });

  // ========================================================
  // Section 6: End-to-End Integration Flow
  // ========================================================
  describe('End-to-End Event Chain: Payment -> Kafka -> Risk Engine -> Kafka -> Payment Service', () => {
    it('executes full pipeline: Critical payment triggers BLOCK and transitions payment to FAILED', async () => {
      // 1. Create a payment in Payment Service
      const payment = await paymentRepo.create({
        merchantId: testMerchantId,
        customerId: testCustomerId,
        amountMinor: 600000, // Exceeds high payment amount (> 500,000) -> +35 pts
        currency: 'INR',
        status: 'PENDING',
        metadata: {},
      });

      // Prime Redis failure and burst signals to reach CRITICAL (>= 75 score):
      // +35 (amount) + 20 (failures) + 15 (burst) + 10 (refunds) = 80 pts -> CRITICAL -> BLOCK
      const now = new Date();
      await recordPaymentFailureSignal(redisClient, testCustomerId, now, 300);
      await recordPaymentFailureSignal(redisClient, testCustomerId, now, 300);
      await recordPaymentFailureSignal(redisClient, testCustomerId, now, 300);
      await recordPaymentFailureSignal(redisClient, testCustomerId, now, 300);
      await recordPaymentFailureSignal(redisClient, testCustomerId, now, 300);

      // Pre-seed burst keys in Redis
      const burstKey = `risk:burst:customer:${testCustomerId}`;
      await redisClient.zadd(burstKey, now.getTime() - 1000, 'b1');
      await redisClient.zadd(burstKey, now.getTime() - 500, 'b2');
      await redisClient.zadd(burstKey, now.getTime() - 100, 'b3');
      await redisClient.zadd(burstKey, now.getTime(), 'b4');

      // Pre-seed refund keys in Redis
      await recordRefundSignal(redisClient, testMerchantId, now, 600);
      await recordRefundSignal(redisClient, testMerchantId, now, 600);
      await recordRefundSignal(redisClient, testMerchantId, now, 600);

      // 2. Publish `payment.created` to Kafka
      const paymentCreatedEvent = createEventEnvelope({
        eventType: DomainEventTypes.PAYMENT_CREATED,
        aggregateId: payment.id,
        payload: {
          id: payment.id,
          merchant_id: payment.merchantId,
          customer_id: payment.customerId,
          amount_minor: payment.amountMinor,
          currency: payment.currency,
          status: payment.status,
        },
      });

      // 3. Risk Consumer receives payment.created
      await riskConsumer.handleIncomingMessage({
        topic: KafkaTopics.PAYMENT_EVENTS,
        partition: 0,
        message: {
          offset: '501',
          key: payment.id,
          value: JSON.stringify(paymentCreatedEvent),
          timestamp: String(Date.now()),
        },
      });

      // 4. Verify Risk Assessment was computed and persisted
      const assessment = await riskRepo.findByPaymentId(payment.id);
      expect(assessment).not.toBeNull();
      expect(assessment!.riskScore).toBeGreaterThanOrEqual(75);
      expect(assessment!.riskLevel).toBe('CRITICAL');
      expect(assessment!.decision).toBe('BLOCK');

      // 5. Verify Risk Engine published `payment.risk.evaluated` event to Kafka
      const publishedEvents = kafkaClient.getPublishedEvents(KafkaTopics.PAYMENT_EVENTS);
      const riskEvaluatedMsg = publishedEvents.find((m) => {
        try {
          const env = JSON.parse(m.value);
          const type = env.event_type || env.eventType;
          const aggId = env.aggregate_id || env.aggregateId;
          return type === DomainEventTypes.PAYMENT_RISK_EVALUATED && aggId === payment.id;
        } catch {
          return false;
        }
      });
      expect(riskEvaluatedMsg).toBeDefined();

      // 6. PaymentRiskDecisionConsumer receives `payment.risk.evaluated`
      await paymentRiskConsumer.handleIncomingMessage({
        topic: KafkaTopics.PAYMENT_EVENTS,
        partition: 0,
        message: {
          offset: '502',
          key: payment.id,
          value: riskEvaluatedMsg!.value,
          timestamp: String(Date.now()),
        },
      });

      // 7. Verify Payment Service transitioned payment state to FAILED
      const updatedPayment = await paymentRepo.findPaymentById(payment.id);
      expect(updatedPayment?.status).toBe('FAILED');
      expect(updatedPayment?.metadata?.risk_decision).toBe('BLOCK');
      expect(updatedPayment?.metadata?.failure_reason).toContain('Blocked by Risk Engine');
    });

    it('executes full pipeline: Low-risk payment produces ALLOW and leaves payment pending capture', async () => {
      const payment = await paymentRepo.create({
        merchantId: 'clean-merchant',
        customerId: 'clean-customer',
        amountMinor: 2000, // Small amount ($20)
        currency: 'INR',
        status: 'PENDING',
        metadata: {},
      });

      const paymentCreatedEvent = createEventEnvelope({
        eventType: DomainEventTypes.PAYMENT_CREATED,
        aggregateId: payment.id,
        payload: {
          id: payment.id,
          merchant_id: payment.merchantId,
          customer_id: payment.customerId,
          amount_minor: payment.amountMinor,
          currency: payment.currency,
          status: payment.status,
        },
      });

      await riskConsumer.handleIncomingMessage({
        topic: KafkaTopics.PAYMENT_EVENTS,
        partition: 0,
        message: {
          offset: '601',
          key: payment.id,
          value: JSON.stringify(paymentCreatedEvent),
          timestamp: String(Date.now()),
        },
      });

      const assessment = await riskRepo.findByPaymentId(payment.id);
      expect(assessment).not.toBeNull();
      expect(assessment!.riskScore).toBe(0);
      expect(assessment!.riskLevel).toBe('LOW');
      expect(assessment!.decision).toBe('ALLOW');

      const publishedEvents = kafkaClient.getPublishedEvents(KafkaTopics.PAYMENT_EVENTS);
      const riskEvaluatedMsg = publishedEvents.find((m) => {
        try {
          const env = JSON.parse(m.value);
          const type = env.event_type || env.eventType;
          const aggId = env.aggregate_id || env.aggregateId;
          return type === DomainEventTypes.PAYMENT_RISK_EVALUATED && aggId === payment.id;
        } catch {
          return false;
        }
      });
      expect(riskEvaluatedMsg).toBeDefined();

      await paymentRiskConsumer.handleIncomingMessage({
        topic: KafkaTopics.PAYMENT_EVENTS,
        partition: 0,
        message: {
          offset: '602',
          key: payment.id,
          value: riskEvaluatedMsg!.value,
          timestamp: String(Date.now()),
        },
      });

      const updatedPayment = await paymentRepo.findPaymentById(payment.id);
      expect(updatedPayment?.status).toBe('CREATED');
      expect(updatedPayment?.metadata?.risk_decision).toBe('ALLOW');
    });
  });
});
