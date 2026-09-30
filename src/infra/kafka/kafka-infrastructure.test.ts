import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../server.js';
import {
  InMemoryKafkaClient,
  checkKafkaHealth,
  setKafkaClient,
  resetKafkaClient,
} from './kafka.client.js';
import { KafkaProducerService } from './kafka-producer.js';
import {
  WebhookConsumer,
  RiskConsumer,
  SettlementConsumer,
  InMemoryProcessedEventsRepository,
} from './kafka-consumer.js';
import { createEventEnvelope, EventTypes, KafkaTopics } from './event-envelope.js';
import { kafkaMetrics } from './kafka.metrics.js';
import {
  InMemoryOutboxRepository,
  setOutboxRepository,
  resetOutboxRepository,
} from '../outbox/outbox.repository.js';
import { OutboxPublisher } from '../outbox/outbox-publisher.js';
import {
  InMemoryPaymentRepository,
} from '../../modules/payments/payment.repository.js';
import { PaymentService } from '../../modules/payments/payment.service.js';
import {
  createLedgerContainer,
  setLedgerContainer,
  seedDemoLedgerAccounts,
} from '../../modules/ledger/ledger.container.js';
import { InMemoryLedgerRepository } from '../../modules/ledger/ledger.repository.js';
import { InMemoryRedisClient, setRedisClient, resetRedisClient } from '../redis/redis.client.js';
import { seedDemoData } from '../../modules/payments/payment.container.js';

describe('Milestone 6: Kafka & Event-Driven Architecture', () => {
  let mockKafka: InMemoryKafkaClient;
  let producerService: KafkaProducerService;
  let outboxRepo: InMemoryOutboxRepository;
  let processedRepo: InMemoryProcessedEventsRepository;
  let publisher: OutboxPublisher;
  let mockRedis: InMemoryRedisClient;

  beforeEach(() => {
    resetKafkaClient();
    resetOutboxRepository();
    resetRedisClient();
    kafkaMetrics.reset();

    mockKafka = new InMemoryKafkaClient();
    setKafkaClient(mockKafka);

    mockRedis = new InMemoryRedisClient();
    setRedisClient(mockRedis);

    outboxRepo = new InMemoryOutboxRepository();
    setOutboxRepository(outboxRepo);

    processedRepo = new InMemoryProcessedEventsRepository();
    producerService = new KafkaProducerService(async () => mockKafka.producer());
    publisher = new OutboxPublisher(outboxRepo, producerService, { batchSize: 50, pollIntervalMs: 100 });
  });

  describe('1. Kafka Connection, Health & Readiness', () => {
    it('reports connected status and healthy ping', async () => {
      const ping = await mockKafka.ping();
      expect(ping).toBe(true);

      const health = await checkKafkaHealth();
      expect(health.connected).toBe(true);
      expect(health.latencyMs).toBeDefined();
    });

    it('reports degraded status when Kafka broker becomes unavailable', async () => {
      mockKafka.setAvailable(false);
      resetKafkaClient();
      setKafkaClient(mockKafka);

      const health = await checkKafkaHealth();
      expect(health.connected).toBe(false);
      expect(health.error).toBeDefined();
    });

    it('exposes Kafka dependency, metrics and health in /ready endpoint', async () => {
      const app = createServer();
      const res = await request(app).get('/ready');

      expect([200, 503]).toContain(res.status);
      expect(res.body.dependencies.kafka).toBeDefined();
      expect(res.body.health.kafka).toBeDefined();
      expect(res.body.metrics.kafka).toBeDefined();
      expect(res.body.metrics.kafka.kafka_connection_status).toBeDefined();
    });
  });

  describe('2. Event Envelope, Partitioning & Topic Routing', () => {
    it('creates a standard validated event envelope without sensitive data', () => {
      const event = createEventEnvelope({
        eventType: EventTypes.PAYMENT_CAPTURED,
        aggregateType: 'payment',
        aggregateId: 'pay_test_123',
        correlationId: 'req_test_abc',
        payload: {
          payment_id: 'pay_test_123',
          amount_minor: 10000,
          currency: 'INR',
          password_hash: 'secret_hash_should_be_stripped',
          api_key: 'sensitive_key_should_be_stripped',
        },
      });

      expect(event.event_id).toMatch(/^evt_/);
      expect(event.event_type).toBe('payment.captured');
      expect(event.event_version).toBe(1);
      expect(event.producer).toBe('payment-service');
      expect(event.correlation_id).toBe('req_test_abc');
      expect(event.aggregate_type).toBe('payment');
      expect(event.aggregate_id).toBe('pay_test_123');
      expect(event.payload.amount_minor).toBe(10000);
      expect((event.payload as Record<string, unknown>).password_hash).toBeUndefined();
      expect((event.payload as Record<string, unknown>).api_key).toBeUndefined();
    });

    it('enforces partition-local ordering by using payment_id as partitionKey', async () => {
      const paymentId = 'pay_partition_test_999';

      const res1 = await producerService.publishEvent(
        createEventEnvelope({
          eventType: EventTypes.PAYMENT_CREATED,
          aggregateType: 'payment',
          aggregateId: paymentId,
          payload: { status: 'CREATED' },
        })
      );

      const res2 = await producerService.publishEvent(
        createEventEnvelope({
          eventType: EventTypes.PAYMENT_AUTHORIZED,
          aggregateType: 'payment',
          aggregateId: paymentId,
          payload: { status: 'AUTHORIZED' },
        })
      );

      const res3 = await producerService.publishEvent(
        createEventEnvelope({
          eventType: EventTypes.PAYMENT_CAPTURED,
          aggregateType: 'payment',
          aggregateId: paymentId,
          payload: { status: 'CAPTURED' },
        })
      );

      expect(res1.partitionKey).toBe(paymentId);
      expect(res2.partitionKey).toBe(paymentId);
      expect(res3.partitionKey).toBe(paymentId);
      expect(res1.topic).toBe(KafkaTopics.PAYMENT_EVENTS);
    });
  });

  describe('3. Consumer Groups & Independent Fanout', () => {
    it('dispatches the same event to independent consumer groups independently', async () => {
      const webhookConsumer = new WebhookConsumer(processedRepo);
      const riskConsumer = new RiskConsumer(processedRepo);
      const settlementConsumer = new SettlementConsumer(processedRepo);

      await webhookConsumer.start();
      await riskConsumer.start();
      await settlementConsumer.start();

      const envelope = createEventEnvelope({
        eventType: EventTypes.PAYMENT_CAPTURED,
        aggregateType: 'payment',
        aggregateId: 'pay_multigroup_1',
        payload: { payment_id: 'pay_multigroup_1', amount_minor: 50000 },
      });

      await producerService.publishEvent(envelope);

      expect(webhookConsumer.handledEvents.length).toBe(1);
      expect(webhookConsumer.handledEvents[0].event_id).toBe(envelope.event_id);

      expect(riskConsumer.handledEvents.length).toBe(1);
      expect(riskConsumer.handledEvents[0].event_id).toBe(envelope.event_id);

      expect(settlementConsumer.handledEvents.length).toBe(1);
      expect(settlementConsumer.handledEvents[0].event_id).toBe(envelope.event_id);

      await webhookConsumer.stop();
      await riskConsumer.stop();
      await settlementConsumer.stop();
    });
  });

  describe('4. Consumer Idempotency', () => {
    it('processes event on first delivery and safely ignores on duplicate redelivery', async () => {
      const webhookConsumer = new WebhookConsumer(processedRepo);
      await webhookConsumer.start();

      const envelope = createEventEnvelope({
        eventType: EventTypes.PAYMENT_CAPTURED,
        aggregateType: 'payment',
        aggregateId: 'pay_idem_test',
        payload: { payment_id: 'pay_idem_test', amount_minor: 2500 },
      });

      // 1. First delivery
      await producerService.publishEvent(envelope);
      expect(webhookConsumer.handledEvents.length).toBe(1);

      // 2. Duplicate redelivery (simulating Kafka replay or retry)
      await producerService.publishEvent(envelope);

      // Handler is NOT invoked a second time!
      expect(webhookConsumer.handledEvents.length).toBe(1);

      // Metric recorded
      const snapshot = kafkaMetrics.getSnapshot();
      expect(snapshot.events_duplicate_total).toBe(1);

      await webhookConsumer.stop();
    });
  });

  describe('5. Transactional Outbox Pattern & Payment Lifecycle', () => {
    it('creates outbox events transactionally when payments change state', async () => {
      const paymentRepo = new InMemoryPaymentRepository(outboxRepo);
      await seedDemoData(paymentRepo);
      const ledgerRepo = new InMemoryLedgerRepository();
      await seedDemoLedgerAccounts(ledgerRepo);
      const ledgerContainer = await createLedgerContainer(ledgerRepo);
      setLedgerContainer(ledgerContainer);

      const paymentService = new PaymentService(paymentRepo, ledgerContainer.service);

      // 1. Create Payment
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 10000,
        currency: 'INR',
      });

      let pending = await outboxRepo.fetchUnpublished(10);
      expect(pending.length).toBe(1);
      expect(pending[0].eventType).toBe('payment.created');
      expect(pending[0].aggregateId).toBe(payment.id);
      expect(pending[0].status).toBe('PENDING');

      // 2. Initiate Payment (CREATED -> PENDING)
      outboxRepo.unlockAll();
      await paymentService.initiatePayment(payment.id);
      pending = await outboxRepo.fetchUnpublished(10);
      expect(pending.length).toBe(2);
      expect(pending[1].eventType).toBe('payment.pending');

      // 3. Authorize Payment (PENDING -> AUTHORIZED)
      outboxRepo.unlockAll();
      await paymentService.authorizePayment(payment.id);
      pending = await outboxRepo.fetchUnpublished(10);
      expect(pending.length).toBe(3);
      expect(pending[2].eventType).toBe('payment.authorized');

      // 4. Capture Payment (AUTHORIZED -> CAPTURED)
      outboxRepo.unlockAll();
      await paymentService.capturePayment(payment.id);
      pending = await outboxRepo.fetchUnpublished(10);
      expect(pending.length).toBe(4);
      expect(pending[3].eventType).toBe('payment.captured');
      expect(pending[3].topic).toBe(KafkaTopics.PAYMENT_EVENTS);

      // 5. Execute Refund
      outboxRepo.unlockAll();
      await paymentService.refundPayment(payment.id, 5000, 'partial refund');
      pending = await outboxRepo.fetchUnpublished(10);
      expect(pending.length).toBe(6);
      expect(pending[4].eventType).toBe('refund.created');
      expect(pending[5].eventType).toBe('refund.completed');
      expect(pending[5].topic).toBe(KafkaTopics.REFUND_EVENTS);
      expect(pending[5].partitionKey).toBe(payment.id);
    });

    it('rolls back outbox event atomically if payment operation fails', async () => {
      const paymentRepo = new InMemoryPaymentRepository(outboxRepo);
      await seedDemoData(paymentRepo);
      const ledgerRepo = new InMemoryLedgerRepository();
      await seedDemoLedgerAccounts(ledgerRepo);
      const ledgerContainer = await createLedgerContainer(ledgerRepo);

      const paymentService = new PaymentService(paymentRepo, ledgerContainer.service);

      // Create initial payment
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 10000,
        currency: 'INR',
      });

      const initialCount = (await outboxRepo.fetchUnpublished(50)).length;
      outboxRepo.unlockAll();

      // Attempt invalid transition: directly CAPTURE a payment in CREATED state
      await expect(paymentService.capturePayment(payment.id)).rejects.toThrow();

      // No new outbox event should have been committed!
      const afterCount = (await outboxRepo.fetchUnpublished(50)).length;
      expect(afterCount).toBe(initialCount);
    });
  });

  describe('6. Outbox Publisher Worker & Retry Resilience', () => {
    it('publishes unpublished outbox events to Kafka and marks them as PUBLISHED', async () => {
      // Seed outbox event
      const event = await outboxRepo.saveEvent({
        eventType: 'payment.captured',
        aggregateType: 'payment',
        aggregateId: 'pay_pub_test_1',
        payload: { payment_id: 'pay_pub_test_1', amount_minor: 10000 },
        topic: KafkaTopics.PAYMENT_EVENTS,
        partitionKey: 'pay_pub_test_1',
      });

      expect(event.status).toBe('PENDING');

      // Execute publisher batch
      const result = await publisher.processBatch();
      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);

      // Verify status in repository
      const updated = await outboxRepo.findById(event.id);
      expect(updated?.status).toBe('PUBLISHED');
      expect(updated?.publishedAt).toBeInstanceOf(Date);

      // Verify message received in Kafka
      const kafkaMessages = mockKafka.getMessages(KafkaTopics.PAYMENT_EVENTS);
      expect(kafkaMessages.length).toBe(1);
      expect(JSON.parse(kafkaMessages[0].value).event_type).toBe('payment.captured');
    });

    it('records failure and increments attempts when Kafka broker is unavailable', async () => {
      const event = await outboxRepo.saveEvent({
        eventType: 'payment.captured',
        aggregateType: 'payment',
        aggregateId: 'pay_fail_test',
        payload: { payment_id: 'pay_fail_test' },
        topic: KafkaTopics.PAYMENT_EVENTS,
        partitionKey: 'pay_fail_test',
        maxAttempts: 3,
      });

      // Disconnect Kafka broker
      mockKafka.setAvailable(false);

      // Execute publisher batch
      const result = await publisher.processBatch();
      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);

      // Verify attempt count incremented and error recorded
      const failedEvent = await outboxRepo.findById(event.id);
      expect(failedEvent?.attempts).toBe(1);
      expect(failedEvent?.lastError).toBeDefined();
      expect(failedEvent?.status).toBe('PENDING'); // Retryable

      // Retry until max attempts reached
      outboxRepo.unlockAll();
      await publisher.processBatch();
      outboxRepo.unlockAll();
      await publisher.processBatch();

      const exhaustedEvent = await outboxRepo.findById(event.id);
      expect(exhaustedEvent?.attempts).toBe(3);
      expect(exhaustedEvent?.status).toBe('FAILED');
    });

    it('allows concurrent publisher workers without processing the same event twice', async () => {
      for (let i = 0; i < 5; i++) {
        await outboxRepo.saveEvent({
          eventType: 'payment.created',
          aggregateType: 'payment',
          aggregateId: `pay_concur_${i}`,
          payload: { id: i },
          topic: KafkaTopics.PAYMENT_EVENTS,
          partitionKey: `pay_concur_${i}`,
        });
      }

      const publisher1 = new OutboxPublisher(outboxRepo, producerService, { batchSize: 5 });
      const publisher2 = new OutboxPublisher(outboxRepo, producerService, { batchSize: 5 });

      // Run both concurrently
      const [res1, res2] = await Promise.all([
        publisher1.processBatch(),
        publisher2.processBatch(),
      ]);

      // Exactly 5 events processed total, zero overlap
      expect(res1.succeeded + res2.succeeded).toBe(5);

      const messages = mockKafka.getMessages(KafkaTopics.PAYMENT_EVENTS);
      expect(messages.length).toBe(5);
    });
  });

  describe('7. End-to-End Failure Scenario (Kafka Down During Financial Mutation)', () => {
    it('executes financial transaction safely in database even if Kafka is down', async () => {
      const paymentRepo = new InMemoryPaymentRepository(outboxRepo);
      await seedDemoData(paymentRepo);
      const ledgerRepo = new InMemoryLedgerRepository();
      await seedDemoLedgerAccounts(ledgerRepo);
      const ledgerContainer = await createLedgerContainer(ledgerRepo);
      setLedgerContainer(ledgerContainer);

      const paymentService = new PaymentService(paymentRepo, ledgerContainer.service);

      // Simulate total Kafka failure
      mockKafka.setAvailable(false);

      // 1. Payment creation succeeds (authoritative database transaction)
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 20000,
        currency: 'INR',
      });
      expect(payment.id).toBeDefined();

      // 2. Transitions proceed under database row locks
      await paymentService.initiatePayment(payment.id);
      await paymentService.authorizePayment(payment.id);
      await paymentService.capturePayment(payment.id);

      // 3. Double-entry ledger is 100% balanced
      const integrity = await ledgerContainer.service.verifyLedgerIntegrity();
      expect(integrity.healthy).toBe(true);

      // 4. Outbox events are safely stored in database queue
      outboxRepo.unlockAll();
      const unpublished = await outboxRepo.fetchUnpublished(20);
      expect(unpublished.length).toBe(4); // created, pending, authorized, captured

      // 5. When Kafka recovers later, outbox publisher drains the backlog
      mockKafka.setAvailable(true);
      outboxRepo.unlockAll();
      const drainResult = await publisher.processBatch();
      expect(drainResult.succeeded).toBe(4);

      const publishedMessages = mockKafka.getMessages(KafkaTopics.PAYMENT_EVENTS);
      expect(publishedMessages.length).toBe(4);
    });
  });
});
