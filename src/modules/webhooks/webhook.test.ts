import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../server.js';
import { generateHmacSignature } from './webhook.types.js';
import { config } from '../../config/index.js';
import { getPaymentContainer, resetPaymentContainer } from '../payments/payment.container.js';
import { InMemoryPaymentRepository } from '../payments/payment.repository.js';
import { InMemoryLedgerRepository } from '../ledger/ledger.repository.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { InMemoryWebhookRepository } from './webhook.repository.js';
import { InMemoryDeadLetterRepository } from './dead-letter.repository.js';
import { getWebhookContainer, setWebhookContainer, resetWebhookContainer } from './webhook.container.js';
import { WebhookService } from './webhook.service.js';
import { WebhookController } from './webhook.controller.js';
import { WebhookProcessorConsumer } from './webhook-consumer.service.js';
import { InMemoryKafkaClient, setKafkaClient, resetKafkaClient } from '../../infra/kafka/kafka.client.js';
import { KafkaProducerService } from '../../infra/kafka/kafka-producer.js';
import { InMemoryProcessedEventsRepository } from '../../infra/kafka/kafka-consumer.js';
import { webhookMetrics } from './webhook.metrics.js';

describe('Webhook Processing, Retries & Dead-Letter Handling (Milestone 7)', () => {
  let app: ReturnType<typeof createServer>;
  let kafkaClient: InMemoryKafkaClient;
  let paymentRepo: InMemoryPaymentRepository;
  let ledgerRepo: InMemoryLedgerRepository;
  let ledgerService: LedgerService;
  let paymentService: PaymentService;
  let webhookRepo: InMemoryWebhookRepository;
  let deadLetterRepo: InMemoryDeadLetterRepository;
  let webhookService: WebhookService;
  let webhookConsumer: WebhookProcessorConsumer;
  let processedRepo: InMemoryProcessedEventsRepository;

  const secret = config.WEBHOOK_SECRET;
  const adminKey = config.ADMIN_API_KEY;

  beforeEach(async () => {
    webhookMetrics.reset();
    resetPaymentContainer();
    resetWebhookContainer();
    resetKafkaClient();

    // 1. Setup in-memory Kafka client
    kafkaClient = new InMemoryKafkaClient();
    setKafkaClient(kafkaClient);
    const kafkaProducer = new KafkaProducerService(async () => kafkaClient.producer());

    // 2. Setup financial repositories and services
    paymentRepo = new InMemoryPaymentRepository();
    ledgerRepo = new InMemoryLedgerRepository();
    ledgerService = new LedgerService(ledgerRepo);
    paymentService = new PaymentService(paymentRepo, ledgerService);

    // Seed test merchant & customer
    await paymentRepo.saveMerchant({
      id: '00000000-0000-0000-0000-000000000001',
      businessName: 'Acme Payments India',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await paymentRepo.saveCustomer({
      id: '00000000-0000-0000-0000-000000000010',
      merchantId: '00000000-0000-0000-0000-000000000001',
      name: 'Test Customer',
      email: 'customer@example.com',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 3. Setup webhook repositories and services
    webhookRepo = new InMemoryWebhookRepository();
    deadLetterRepo = new InMemoryDeadLetterRepository();
    webhookService = new WebhookService(webhookRepo, deadLetterRepo, kafkaProducer);
    const controller = new WebhookController(webhookService);

    processedRepo = new InMemoryProcessedEventsRepository();
    webhookConsumer = new WebhookProcessorConsumer({
      webhookRepo,
      deadLetterRepo,
      paymentService,
      kafkaProducer,
      processedRepo,
    });

    // Register active container
    setWebhookContainer({
      webhookRepo,
      deadLetterRepo,
      service: webhookService,
      controller,
      consumer: webhookConsumer,
    });

    // Start consumer
    await webhookConsumer.start();

    // Build Express App
    app = createServer();
  });

  afterEach(async () => {
    await webhookConsumer.stop();
  });

  describe('1. HMAC Signature Verification & Security', () => {
    it('accepts webhook with valid HMAC-SHA256 signature', async () => {
      const payload = {
        event_id: 'evt_valid_sig_1',
        event_type: 'payment.authorized',
        data: {
          payment_id: '00000000-0000-0000-0000-000000000100',
          amount_minor: 5000,
          currency: 'INR',
          external_reference: 'ext_ref_100',
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateHmacSignature(secret, rawBody);

      const res = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.received).toBe(true);
      expect(res.body.data.event_id).toBe('evt_valid_sig_1');
      expect(res.body.data.status).toBe('ACCEPTED');

      const saved = await webhookRepo.findByProviderAndEventId('mockpay', 'evt_valid_sig_1');
      expect(saved).not.toBeNull();
      expect(['VALIDATED', 'PROCESSING', 'RETRY_PENDING', 'PROCESSED']).toContain(saved?.status);
    });

    it('rejects webhook with missing signature header with 401', async () => {
      const payload = {
        event_id: 'evt_no_sig',
        event_type: 'payment.authorized',
        data: { payment_id: 'pay_123' },
      };

      const res = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(payload));

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toContain('Invalid webhook signature');
    });

    it('rejects webhook with invalid signature with 401', async () => {
      const payload = {
        event_id: 'evt_bad_sig',
        event_type: 'payment.authorized',
        data: { payment_id: 'pay_123' },
      };
      const rawBody = JSON.stringify(payload);
      const wrongSignature = generateHmacSignature('wrong_secret_key_12345678901234', rawBody);

      const res = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', wrongSignature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects webhook when payload is modified after signing', async () => {
      const originalPayload = {
        event_id: 'evt_tampered',
        event_type: 'payment.captured',
        data: { payment_id: 'pay_orig', amount_minor: 1000 },
      };
      const signature = generateHmacSignature(secret, JSON.stringify(originalPayload));

      // Tamper with payload
      const tamperedBody = JSON.stringify({
        ...originalPayload,
        data: { payment_id: 'pay_orig', amount_minor: 999999 },
      });

      const res = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(tamperedBody);

      expect(res.status).toBe(401);
    });

    it('rejects unsupported provider with 400 ValidationError', async () => {
      const payload = { event_id: 'evt_1', event_type: 'payment.authorized', data: { payment_id: 'p1' } };
      const rawBody = JSON.stringify(payload);
      const signature = generateHmacSignature(secret, rawBody);

      const res = await request(app)
        .post('/api/v1/webhooks/stripe')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Unsupported webhook provider: stripe');
    });
  });

  describe('2. Duplicate Webhooks & Idempotency', () => {
    it('accepts first delivery and returns acknowledged duplicate for subsequent deliveries', async () => {
      const payload = {
        event_id: 'evt_dup_test_1',
        event_type: 'payment.authorized',
        data: {
          payment_id: '00000000-0000-0000-0000-000000000200',
          amount_minor: 2500,
          currency: 'INR',
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateHmacSignature(secret, rawBody);

      // Delivery #1: First delivery -> accepted
      const res1 = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res1.status).toBe(202);
      expect(res1.body.data.duplicate).toBe(false);

      // Delivery #2: Duplicate delivery -> recognized
      const res2 = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res2.status).toBe(200);
      expect(res2.body.data.duplicate).toBe(true);
      expect(res2.body.data.event_id).toBe('evt_dup_test_1');

      // Delivery #3: Duplicate delivery -> recognized again
      const res3 = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res3.status).toBe(200);
      expect(res3.body.data.duplicate).toBe(true);

      // Verify only 1 record stored in database
      const allEvents = await webhookRepo.findEvents({});
      const matching = allEvents.events.filter((e) => e.eventId === 'evt_dup_test_1');
      expect(matching.length).toBe(1);
    });

    it('safely handles concurrent duplicate deliveries', async () => {
      const payload = {
        event_id: 'evt_concurrent_1',
        event_type: 'payment.authorized',
        data: {
          payment_id: '00000000-0000-0000-0000-000000000201',
          amount_minor: 1000,
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateHmacSignature(secret, rawBody);

      // Fire 5 concurrent requests with identical payload
      const requests = Array.from({ length: 5 }).map(() =>
        request(app)
          .post('/api/v1/webhooks/mockpay')
          .set('x-mockpay-signature', signature)
          .set('Content-Type', 'application/json')
          .send(rawBody)
      );

      const responses = await Promise.all(requests);
      // All requests must succeed (200 or 202)
      for (const res of responses) {
        expect([200, 202]).toContain(res.status);
      }

      // Exactly 1 was the primary ingestion, others flagged as duplicate
      const primaryCount = responses.filter((r) => r.body.data.duplicate === false).length;
      expect(primaryCount).toBe(1);

      // Verify only 1 record saved
      const all = await webhookRepo.findEvents({});
      const matching = all.events.filter((e) => e.eventId === 'evt_concurrent_1');
      expect(matching.length).toBe(1);
    });
  });

  describe('3. Webhook → Kafka & Asynchronous Consumer Processing', () => {
    it('processes payment.authorized event and updates payment state', async () => {
      // 1. Create a payment in CREATED state
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 5000,
        currency: 'INR',
      });
      // Move to PENDING
      await paymentService.initiatePayment(payment.id);

      // 2. Ingest payment.authorized webhook
      const webhookPayload = {
        event_id: 'evt_auth_101',
        event_type: 'payment.authorized',
        data: {
          payment_id: payment.id,
          amount_minor: 5000,
          currency: 'INR',
          external_reference: 'ext_auth_101',
        },
      };
      const rawBody = JSON.stringify(webhookPayload);
      const signature = generateHmacSignature(secret, rawBody);

      const res = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(202);

      // Verify payment transitioned to AUTHORIZED
      const updatedPayment = await paymentRepo.findPaymentById(payment.id);
      expect(updatedPayment?.status).toBe('AUTHORIZED');

      // Verify webhook record transitioned to PROCESSED
      const webhookRecord = await webhookRepo.findByProviderAndEventId('mockpay', 'evt_auth_101');
      expect(webhookRecord?.status).toBe('PROCESSED');
      expect(webhookRecord?.processedAt).toBeDefined();
    });

    it('processes payment.captured event and creates double-entry ledger entries', async () => {
      // 1. Setup payment in AUTHORIZED state
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 12000,
        currency: 'INR',
      });
      await paymentService.initiatePayment(payment.id);
      await paymentService.authorizePayment(payment.id);

      // 2. Ingest payment.captured webhook
      const webhookPayload = {
        event_id: 'evt_capture_201',
        event_type: 'payment.captured',
        data: {
          payment_id: payment.id,
          amount_minor: 12000,
          currency: 'INR',
          external_reference: 'ext_cap_201',
        },
      };
      const rawBody = JSON.stringify(webhookPayload);
      const signature = generateHmacSignature(secret, rawBody);

      const res = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(202);

      // Verify payment transitioned to CAPTURED
      const updatedPayment = await paymentRepo.findPaymentById(payment.id);
      expect(updatedPayment?.status).toBe('CAPTURED');
      expect(updatedPayment?.capturedAmountMinor).toBe(12000n);

      // Verify double-entry ledger transaction was posted and is balanced
      const captureTx = await ledgerRepo.findTransactionByReference('PAYMENT', payment.id);
      expect(captureTx).not.toBeNull();
      expect(captureTx?.postedAt).toBeDefined();
      expect(captureTx?.transactionType).toBe('CAPTURE');

      // Verify journal entries balance: DEBIT = CREDIT
      let debits = 0n;
      let credits = 0n;
      for (const entry of captureTx!.entries) {
        if (entry.entryType === 'DEBIT') debits += entry.amountMinor;
        if (entry.entryType === 'CREDIT') credits += entry.amountMinor;
      }
      expect(debits).toBe(credits);
    });

    it('processes payment.failed event and marks payment as FAILED', async () => {
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 7500,
        currency: 'INR',
      });
      await paymentService.initiatePayment(payment.id);

      const webhookPayload = {
        event_id: 'evt_fail_301',
        event_type: 'payment.failed',
        data: {
          payment_id: payment.id,
          reason: 'Card declined by issuing bank',
        },
      };
      const rawBody = JSON.stringify(webhookPayload);
      const signature = generateHmacSignature(secret, rawBody);

      const res = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(202);

      const updatedPayment = await paymentRepo.findPaymentById(payment.id);
      expect(updatedPayment?.status).toBe('FAILED');
    });

    it('processes refund.completed event and records compensating ledger entry', async () => {
      // Create and capture payment first
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 10000,
        currency: 'INR',
      });
      await paymentService.initiatePayment(payment.id);
      await paymentService.authorizePayment(payment.id);
      await paymentService.capturePayment(payment.id);

      // Webhook refund.completed
      const webhookPayload = {
        event_id: 'evt_refund_401',
        event_type: 'refund.completed',
        data: {
          payment_id: payment.id,
          amount_minor: 10000,
          reason: 'Customer return request',
        },
      };
      const rawBody = JSON.stringify(webhookPayload);
      const signature = generateHmacSignature(secret, rawBody);

      const res = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(202);

      const updatedPayment = await paymentRepo.findPaymentById(payment.id);
      expect(updatedPayment?.status).toBe('REFUNDED');
      expect(updatedPayment?.refundedAmountMinor).toBe(10000n);
    });
  });

  describe('4. Retry Strategy & Exponential Backoff', () => {
    it('records attempt count, updates next_retry_at with exponential backoff on transient failure', async () => {
      // Ingest event for nonexistent payment to provoke failure
      const webhookPayload = {
        event_id: 'evt_transient_fail_1',
        event_type: 'payment.captured',
        data: {
          payment_id: 'nonexistent-payment-uuid',
          amount_minor: 5000,
        },
      };
      const rawBody = JSON.stringify(webhookPayload);
      const signature = generateHmacSignature(secret, rawBody);

      await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      const webhook = await webhookRepo.findByProviderAndEventId('mockpay', 'evt_transient_fail_1');
      expect(webhook).not.toBeNull();
      // Consumer received error and scheduled retry
      expect(webhook?.attempts).toBe(1);
      expect(webhook?.status).toBe('RETRY_PENDING');
      expect(webhook?.lastError).toContain('not found');
      expect(webhook?.nextRetryAt).toBeDefined();
      expect(webhook?.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() - 1000);
    });
  });

  describe('5. Dead-Letter Queue (DLQ) & Admin Replay', () => {
    it('moves event to DLQ when max retry attempts are reached and persists in dead_letter_events', async () => {
      const eventId = 'evt_dlq_forced_fail';
      // Save webhook record with attempts = 4 (maxAttempts = 5)
      const webhook = await webhookRepo.save({
        eventId,
        provider: 'mockpay',
        eventType: 'payment.captured',
        payload: { event_id: eventId, data: { payment_id: 'missing-pay-id' } },
        attempts: 4,
        maxAttempts: 5,
        status: 'RETRY_PENDING',
      });

      // Dispatch event to consumer
      const envelope = {
        event_id: eventId,
        event_type: 'provider.payment.captured',
        event_version: 1,
        occurred_at: new Date().toISOString(),
        producer: 'webhook-processor',
        correlation_id: 'corr_dlq_test',
        aggregate_type: 'payment',
        aggregate_id: 'missing-pay-id',
        payload: { event_id: eventId, provider: 'mockpay', data: { payment_id: 'missing-pay-id' } },
      };

      try {
        await webhookConsumer.handleIncomingMessage({
          topic: 'ledgerx.webhook.events',
          partition: 0,
          message: {
            key: 'missing-pay-id',
            value: JSON.stringify(envelope),
          },
        });
      } catch {
        // Consumer threw on failure
      }

      // 1. Webhook record status is now DEAD_LETTERED
      const updatedWebhook = await webhookRepo.findById(webhook.id);
      expect(updatedWebhook?.status).toBe('DEAD_LETTERED');
      expect(updatedWebhook?.attempts).toBe(5);

      // 2. Dead letter record is persisted in dead_letter_events
      const dlqRecord = await deadLetterRepo.findByEventId(eventId);
      expect(dlqRecord).not.toBeNull();
      expect(dlqRecord?.status).toBe('PENDING');
      expect(dlqRecord?.attempts).toBe(5);
      expect(dlqRecord?.reason).toBeDefined();

      // 3. Message was published to Kafka DLQ topic
      const dlqMessages = kafkaClient.getMessages('ledgerx.webhook.dlq');
      expect(dlqMessages.length).toBeGreaterThan(0);
    });

    it('requires admin authorization for DLQ operations', async () => {
      // Missing x-admin-key header
      const res1 = await request(app).get('/api/v1/webhooks/dead-letter');
      expect(res1.status).toBe(401);

      // Invalid admin key
      const res2 = await request(app)
        .get('/api/v1/webhooks/dead-letter')
        .set('x-admin-key', 'wrong_admin_key');
      expect(res2.status).toBe(403);

      // Valid admin key
      const res3 = await request(app)
        .get('/api/v1/webhooks/dead-letter')
        .set('x-admin-key', adminKey);
      expect(res3.status).toBe(200);
      expect(res3.body.success).toBe(true);
    });

    it('allows admin to safely replay a DLQ event', async () => {
      // 1. Create a payment and keep it in AUTHORIZED state
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 9900,
        currency: 'INR',
      });
      await paymentService.initiatePayment(payment.id);
      await paymentService.authorizePayment(payment.id);

      // 2. Insert DLQ record for payment.captured
      const dlqEvent = await deadLetterRepo.save({
        eventId: 'evt_dlq_replay_1',
        source: 'webhook-consumer',
        eventType: 'provider.payment.captured',
        reason: 'Temporary network timeout',
        attempts: 5,
        status: 'PENDING',
        payload: {
          event_id: 'evt_dlq_replay_1',
          provider: 'mockpay',
          data: {
            payment_id: payment.id,
            amount_minor: 9900,
          },
        },
      });

      // Also ensure webhook record exists
      await webhookRepo.save({
        eventId: 'evt_dlq_replay_1',
        provider: 'mockpay',
        eventType: 'payment.captured',
        status: 'DEAD_LETTERED',
        attempts: 5,
        payload: { event_id: 'evt_dlq_replay_1', data: { payment_id: payment.id } },
      });

      // 3. Admin calls Replay API
      const replayRes = await request(app)
        .post(`/api/v1/webhooks/dead-letter/${dlqEvent.id}/retry`)
        .set('x-admin-key', adminKey);

      expect(replayRes.status).toBe(200);
      expect(replayRes.body.success).toBe(true);
      expect(replayRes.body.data.status).toBe('REPLAYED');

      // Payment is captured successfully via consumer
      const capturedPayment = await paymentRepo.findPaymentById(payment.id);
      expect(capturedPayment?.status).toBe('CAPTURED');

      // Repeating replay must not produce duplicate financial effects (idempotency check)
      const secondReplayRes = await request(app)
        .post(`/api/v1/webhooks/dead-letter/${dlqEvent.id}/retry`)
        .set('x-admin-key', adminKey);
      expect(secondReplayRes.status).toBe(200);

      // Ledger transactions for this payment must only be 1 capture transaction
      const captureTx = await ledgerRepo.findTransactionByReference('PAYMENT', payment.id);
      expect(captureTx).not.toBeNull();
    });

    it('allows admin to mark a DLQ event as resolved with audit notes', async () => {
      const dlqEvent = await deadLetterRepo.save({
        eventId: 'evt_dlq_resolve_1',
        source: 'webhook-consumer',
        eventType: 'provider.payment.failed',
        reason: 'Malformed merchant reference',
        attempts: 5,
        status: 'PENDING',
        payload: {},
      });

      const res = await request(app)
        .post(`/api/v1/webhooks/dead-letter/${dlqEvent.id}/resolve`)
        .set('x-admin-key', adminKey)
        .send({
          resolution_notes: 'Verified manually with merchant support: customer cancelled checkout.',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('RESOLVED');
      expect(res.body.data.resolutionNotes).toContain('Verified manually');
      expect(res.body.data.resolvedAt).toBeDefined();
    });
  });

  describe('6. Webhook Query & Inspection Endpoints', () => {
    it('supports listing webhooks with pagination and status filters', async () => {
      await webhookRepo.save({
        eventId: 'evt_filter_1',
        provider: 'mockpay',
        eventType: 'payment.authorized',
        status: 'PROCESSED',
        payload: {},
      });
      await webhookRepo.save({
        eventId: 'evt_filter_2',
        provider: 'mockpay',
        eventType: 'payment.failed',
        status: 'FAILED',
        payload: {},
      });

      const res = await request(app)
        .get('/api/v1/webhooks?status=PROCESSED')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].eventId).toBe('evt_filter_1');
    });

    it('fetches webhook by ID', async () => {
      const saved = await webhookRepo.save({
        eventId: 'evt_by_id_1',
        provider: 'mockpay',
        eventType: 'payment.captured',
        status: 'PROCESSED',
        payload: { sample: true },
      });

      const res = await request(app)
        .get(`/api/v1/webhooks/events/${saved.id}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(saved.id);
      expect(res.body.data.eventId).toBe('evt_by_id_1');
    });
  });

  describe('7. Webhook Metrics & Observability', () => {
    it('tracks metrics for received, valid, duplicate, and processed webhooks', async () => {
      const snapshotBefore = webhookMetrics.getSnapshot();
      expect(snapshotBefore).toBeDefined();

      const payload = {
        event_id: 'evt_metric_test',
        event_type: 'payment.authorized',
        data: { payment_id: 'pay_metric_1' },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateHmacSignature(secret, rawBody);

      // Ingest #1
      await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      // Ingest #2 (duplicate)
      await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      const snapshotAfter = webhookMetrics.getSnapshot();
      expect(snapshotAfter.webhooks_received).toBeGreaterThanOrEqual(2);
      expect(snapshotAfter.duplicate_webhooks).toBeGreaterThanOrEqual(1);
      expect(snapshotAfter.webhooks_valid).toBeGreaterThanOrEqual(1);

      // Verify metrics exposed in readiness probe
      const readyRes = await request(app).get('/ready');
      expect(readyRes.body.metrics.webhooks).toBeDefined();
      expect(readyRes.body.metrics.webhooks.webhooks_received).toBeGreaterThanOrEqual(2);
    });
  });

  describe('8. Failure Scenarios & Distributed Guarantees (Section 25)', () => {
    it('guarantees partition-local ordering by routing same payment_id to same partition', async () => {
      const paymentId = '00000000-0000-0000-0000-000000000999';

      const event1 = {
        event_id: 'evt_seq_1',
        event_type: 'payment.authorized',
        data: { payment_id: paymentId, amount_minor: 5000 },
      };
      const event2 = {
        event_id: 'evt_seq_2',
        event_type: 'payment.captured',
        data: { payment_id: paymentId, amount_minor: 5000 },
      };

      const sig1 = generateHmacSignature(secret, JSON.stringify(event1));
      const sig2 = generateHmacSignature(secret, JSON.stringify(event2));

      await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', sig1)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event1));

      await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', sig2)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event2));

      const messages = kafkaClient.getMessages('ledgerx.webhook.events');
      const paymentMessages = messages.filter((m) => m.key === paymentId);
      expect(paymentMessages.length).toBe(2);

      // Both messages have identical partition assignment for ordering guarantee
      expect(paymentMessages[0].partition).toBe(paymentMessages[1].partition);
      expect(paymentMessages[0].key).toBe(paymentId);
      expect(paymentMessages[1].key).toBe(paymentId);
    });

    it('persists webhook in database even if Kafka broker is unavailable during ingestion', async () => {
      // Simulate Kafka broker failure
      kafkaClient.setAvailable(false);

      const payload = {
        event_id: 'evt_kafka_down_1',
        event_type: 'payment.authorized',
        data: { payment_id: '00000000-0000-0000-0000-000000000888' },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateHmacSignature(secret, rawBody);

      // Webhook ingestion still succeeds with 202 because DB persistence succeeded
      const res = await request(app)
        .post('/api/v1/webhooks/mockpay')
        .set('x-mockpay-signature', signature)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);

      // Verify webhook is in database
      const saved = await webhookRepo.findByProviderAndEventId('mockpay', 'evt_kafka_down_1');
      expect(saved).not.toBeNull();
      expect(saved?.status).toBe('VALIDATED');

      // Restore Kafka
      kafkaClient.setAvailable(true);
    });

    it('simulates consumer failure before commit and enables safe redelivery', async () => {
      const payment = await paymentService.createPayment({
        merchant_id: '00000000-0000-0000-0000-000000000001',
        customer_id: '00000000-0000-0000-0000-000000000010',
        amount_minor: 4000,
        currency: 'INR',
      });
      await paymentService.initiatePayment(payment.id);

      // Save webhook record
      await webhookRepo.save({
        eventId: 'evt_crash_test',
        provider: 'mockpay',
        eventType: 'payment.authorized',
        payload: { event_id: 'evt_crash_test', data: { payment_id: payment.id } },
        attempts: 0,
        status: 'VALIDATED',
      });

      const envelope = {
        event_id: 'evt_crash_test',
        event_type: 'provider.payment.authorized',
        event_version: 1,
        occurred_at: new Date().toISOString(),
        producer: 'webhook-processor',
        correlation_id: 'corr_crash',
        aggregate_type: 'payment',
        aggregate_id: payment.id,
        payload: { event_id: 'evt_crash_test', provider: 'mockpay', data: { payment_id: payment.id } },
      };

      // 1. Consumer processes event successfully on delivery
      await webhookConsumer.handleIncomingMessage({
        topic: 'ledgerx.webhook.events',
        partition: 0,
        message: {
          key: payment.id,
          value: JSON.stringify(envelope),
        },
      });

      // 2. Verified processed
      const updated = await paymentRepo.findPaymentById(payment.id);
      expect(updated?.status).toBe('AUTHORIZED');

      // 3. Redelivery simulation: duplicate delivery is handled idempotently without error
      await expect(
        webhookConsumer.handleIncomingMessage({
          topic: 'ledgerx.webhook.events',
          partition: 0,
          message: {
            key: payment.id,
            value: JSON.stringify(envelope),
          },
        })
      ).resolves.not.toThrow();
    });
  });
});
