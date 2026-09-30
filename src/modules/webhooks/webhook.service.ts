import { IWebhookRepository } from './webhook.repository.js';
import { IDeadLetterRepository } from './dead-letter.repository.js';
import {
  WebhookEventEntity,
  DeadLetterEventEntity,
  WebhookFilter,
  DeadLetterFilter,
  IngestWebhookResponse,
  MockpayWebhookPayload,
  verifyHmacSignature,
} from './webhook.types.js';
import { config } from '../../config/index.js';
import { ValidationError, NotFoundError, UnauthorizedError } from '../../common/errors.js';
import { logger } from '../../common/logger.js';
import { webhookMetrics } from './webhook.metrics.js';
import { KafkaProducerService, getKafkaProducerService } from '../../infra/kafka/kafka-producer.js';
import { createEventEnvelope, KafkaTopics } from '../../infra/kafka/event-envelope.js';

export interface IngestWebhookParams {
  provider: string;
  rawBody: Buffer | string;
  signature?: string;
  correlationId?: string;
  merchantId?: string;
}

export class WebhookService {
  constructor(
    private readonly webhookRepo: IWebhookRepository,
    private readonly deadLetterRepo: IDeadLetterRepository,
    private readonly kafkaProducer: KafkaProducerService = getKafkaProducerService()
  ) {}

  /**
   * Ingests, validates, verifies signature, persists, and queues webhook for async processing.
   */
  public async ingestWebhook(params: IngestWebhookParams): Promise<IngestWebhookResponse> {
    const { provider, rawBody, signature, correlationId, merchantId } = params;
    webhookMetrics.recordReceived();

    // 1. Validate Provider
    const normalizedProvider = provider.toLowerCase();
    if (normalizedProvider !== 'mockpay') {
      webhookMetrics.recordInvalid();
      throw new ValidationError(`Unsupported webhook provider: ${provider}. Supported providers: mockpay`);
    }

    // 2. Validate Signature (HMAC-SHA256, timing-safe)
    const secret = config.WEBHOOK_SECRET;
    const isValidSignature = verifyHmacSignature(secret, rawBody, signature);

    if (!isValidSignature) {
      webhookMetrics.recordInvalid();
      logger.warn(`Webhook security rejection: invalid signature for provider '${provider}'`, {
        event: 'webhook.invalid_signature',
        provider,
        correlationId,
        hasSignature: !!signature,
      });
      throw new UnauthorizedError('Invalid webhook signature');
    }

    webhookMetrics.recordValid();

    // 3. Parse and Validate Raw Payload
    let parsed: MockpayWebhookPayload;
    try {
      const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
      parsed = JSON.parse(bodyStr);
    } catch (err) {
      webhookMetrics.recordInvalid();
      logger.error('Webhook payload parsing error: malformed JSON', {
        event: 'webhook.malformed_payload',
        provider,
        correlationId,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      throw new ValidationError('Malformed JSON webhook payload');
    }

    if (!parsed || typeof parsed !== 'object') {
      webhookMetrics.recordInvalid();
      throw new ValidationError('Webhook payload must be a JSON object');
    }

    if (!parsed.event_id || typeof parsed.event_id !== 'string') {
      webhookMetrics.recordInvalid();
      throw new ValidationError('Missing or invalid event_id in webhook payload');
    }

    if (!parsed.event_type || typeof parsed.event_type !== 'string') {
      webhookMetrics.recordInvalid();
      throw new ValidationError('Missing or invalid event_type in webhook payload');
    }

    if (!parsed.data || typeof parsed.data !== 'object' || !parsed.data.payment_id) {
      webhookMetrics.recordInvalid();
      throw new ValidationError('Webhook data must contain a valid payment_id');
    }

    const eventId = parsed.event_id;
    const eventType = parsed.event_type;
    const paymentId = parsed.data.payment_id;
    const externalRef = parsed.data.external_reference || null;

    // 4. Duplicate Check (Provider + EventId Idempotency)
    const existing = await this.webhookRepo.findByProviderAndEventId(normalizedProvider, eventId);
    if (existing) {
      webhookMetrics.recordDuplicate();
      logger.info(`Duplicate webhook recognized: ${normalizedProvider}/${eventId} - skipping republish`, {
        event: 'webhook.duplicate',
        provider: normalizedProvider,
        eventId,
        existingStatus: existing.status,
        correlationId,
      });

      return {
        received: true,
        duplicate: true,
        id: existing.id,
        event_id: existing.eventId,
        provider: existing.provider,
        status: existing.status,
      };
    }

    // 5. Persist Webhook Event Record
    let saved: WebhookEventEntity;
    try {
      saved = await this.webhookRepo.save({
        eventId,
        provider: normalizedProvider,
        eventType,
        externalReference: externalRef,
        merchantId: merchantId || parsed.data.merchant_id || null,
        signature: signature || null,
        payload: parsed as unknown as Record<string, unknown>,
        status: 'VALIDATED',
        attempts: 0,
        maxAttempts: config.WEBHOOK_MAX_RETRIES,
        receivedAt: new Date(),
      });
    } catch (err: any) {
      // Handle race condition on unique constraint
      if (err.message && err.message.includes('Unique constraint')) {
        webhookMetrics.recordDuplicate();
        const concurrent = await this.webhookRepo.findByProviderAndEventId(normalizedProvider, eventId);
        return {
          received: true,
          duplicate: true,
          id: concurrent?.id,
          event_id: eventId,
          provider: normalizedProvider,
          status: concurrent?.status || 'RECEIVED',
        };
      }
      throw err;
    }

    // 6. Publish Normalized Domain Event to Kafka
    const normalizedEventType = `provider.${eventType}`;
    const envelope = createEventEnvelope({
      eventType: normalizedEventType,
      aggregateType: 'payment',
      aggregateId: paymentId,
      correlationId: correlationId || `wh_corr_${eventId}`,
      producer: 'webhook-processor',
      payload: {
        provider: normalizedProvider,
        webhook_id: saved.id,
        event_id: eventId,
        external_reference: externalRef,
        data: parsed.data,
      },
    });

    try {
      await this.kafkaProducer.publishEvent(envelope, KafkaTopics.WEBHOOK_EVENTS);
    } catch (err) {
      logger.error(`Failed to publish webhook event to Kafka: ${eventId}`, {
        event: 'webhook.kafka_publish_failed',
        eventId,
        provider: normalizedProvider,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      // Webhook is safely persisted in DB; the retry/recovery mechanism can replay it
    }

    logger.info(`Webhook accepted and queued: ${normalizedProvider}/${eventId} (${eventType})`, {
      event: 'webhook.accepted',
      id: saved.id,
      eventId,
      provider: normalizedProvider,
      eventType,
      paymentId,
      correlationId,
    });

    return {
      received: true,
      duplicate: false,
      id: saved.id,
      event_id: saved.eventId,
      provider: normalizedProvider,
      status: 'ACCEPTED',
    };
  }

  public async listWebhooks(filter: WebhookFilter) {
    return this.webhookRepo.findEvents(filter);
  }

  public async getWebhookById(id: string): Promise<WebhookEventEntity> {
    const event = await this.webhookRepo.findById(id);
    if (!event) {
      throw new NotFoundError('WebhookEvent', id);
    }
    return event;
  }

  public async listDeadLetterEvents(filter: DeadLetterFilter) {
    return this.deadLetterRepo.findAll(filter);
  }

  public async getDeadLetterEventById(id: string): Promise<DeadLetterEventEntity> {
    const event = await this.deadLetterRepo.findById(id);
    if (!event) {
      throw new NotFoundError('DeadLetterEvent', id);
    }
    return event;
  }

  /**
   * Replays a dead-lettered event by re-publishing to Kafka and marking DLQ record as REPLAYED.
   */
  public async replayDeadLetterEvent(id: string, actorId = 'admin'): Promise<DeadLetterEventEntity> {
    const dlqRecord = await this.deadLetterRepo.findById(id);
    if (!dlqRecord) {
      throw new NotFoundError('DeadLetterEvent', id);
    }

    const webhookRecord = await this.webhookRepo.findByProviderAndEventId('mockpay', dlqRecord.eventId);
    if (webhookRecord) {
      // Reset attempts and status for retry
      await this.webhookRepo.updateStatus(webhookRecord.id, 'RETRY_PENDING', {
        attempts: 0,
        nextRetryAt: new Date(),
        lastError: `Replayed by ${actorId}`,
      });
    }

    // Requeue to Kafka
    const payload = dlqRecord.payload as any;
    const paymentId = payload?.data?.payment_id || payload?.aggregate_id || 'unknown';
    const envelope = createEventEnvelope({
      eventType: dlqRecord.eventType,
      aggregateType: 'payment',
      aggregateId: paymentId,
      producer: 'webhook-dlq-replay',
      correlationId: `replay_${dlqRecord.eventId}_${Date.now()}`,
      payload: {
        ...payload,
        is_replay: true,
        replayed_by: actorId,
      },
    });

    await this.kafkaProducer.publishEvent(envelope, KafkaTopics.WEBHOOK_EVENTS);

    const updated = await this.deadLetterRepo.updateStatus(id, 'REPLAYED', {
      resolvedBy: actorId,
      resolutionNotes: `Manual replay initiated at ${new Date().toISOString()}`,
    });

    logger.info(`DLQ event replayed: ${id} [${dlqRecord.eventId}]`, {
      event: 'dlq.replayed',
      id,
      eventId: dlqRecord.eventId,
      replayedBy: actorId,
    });

    return updated;
  }

  /**
   * Resolves a dead-lettered event without replaying.
   */
  public async resolveDeadLetterEvent(
    id: string,
    resolutionNotes: string,
    actorId = 'admin'
  ): Promise<DeadLetterEventEntity> {
    const dlqRecord = await this.deadLetterRepo.findById(id);
    if (!dlqRecord) {
      throw new NotFoundError('DeadLetterEvent', id);
    }

    const updated = await this.deadLetterRepo.updateStatus(id, 'RESOLVED', {
      resolvedBy: actorId,
      resolutionNotes,
    });

    logger.info(`DLQ event resolved: ${id} [${dlqRecord.eventId}]`, {
      event: 'dlq.resolved',
      id,
      eventId: dlqRecord.eventId,
      resolvedBy: actorId,
      resolutionNotes,
    });

    return updated;
  }
}
