import { BaseKafkaConsumer, IProcessedEventsRepository, getProcessedEventsRepository } from '../../infra/kafka/kafka-consumer.js';
import { EventEnvelope, KafkaTopics } from '../../infra/kafka/event-envelope.js';
import { KafkaProducerService, getKafkaProducerService } from '../../infra/kafka/kafka-producer.js';
import { IWebhookRepository } from './webhook.repository.js';
import { IDeadLetterRepository } from './dead-letter.repository.js';
import { PaymentService } from '../payments/payment.service.js';
import { config } from '../../config/index.js';
import { logger } from '../../common/logger.js';
import { webhookMetrics } from './webhook.metrics.js';
import { InvalidStateTransitionError } from '../../common/errors.js';

export interface WebhookConsumerDependencies {
  webhookRepo: IWebhookRepository;
  deadLetterRepo: IDeadLetterRepository;
  paymentService: PaymentService;
  kafkaProducer?: KafkaProducerService;
  processedRepo?: IProcessedEventsRepository;
}

export class WebhookProcessorConsumer extends BaseKafkaConsumer {
  private webhookRepo: IWebhookRepository;
  private deadLetterRepo: IDeadLetterRepository;
  private paymentService: PaymentService;
  private kafkaProducer: KafkaProducerService;

  constructor(deps: WebhookConsumerDependencies) {
    super({
      groupId: config.WEBHOOK_CONSUMER_GROUP,
      topics: [KafkaTopics.WEBHOOK_EVENTS],
      processedEventsRepo: deps.processedRepo ?? getProcessedEventsRepository(),
    });
    this.webhookRepo = deps.webhookRepo;
    this.deadLetterRepo = deps.deadLetterRepo;
    this.paymentService = deps.paymentService;
    this.kafkaProducer = deps.kafkaProducer ?? getKafkaProducerService();
  }

  /**
   * Main entry point for Kafka message processing.
   */
  protected async processEvent(event: EventEnvelope<Record<string, unknown>>): Promise<void> {
    const startTime = performance.now();
    const eventId = (event.payload?.event_id as string) || event.event_id;
    const provider = (event.payload?.provider as string) || 'mockpay';
    const paymentId = event.aggregate_id;

    logger.info(`Webhook consumer received event: ${event.event_type} [${eventId}] for payment ${paymentId}`, {
      event: 'webhook_consumer.received',
      eventId,
      eventType: event.event_type,
      paymentId,
      correlationId: event.correlation_id,
    });

    // 1. Load corresponding webhook record
    const webhookRecord = await this.webhookRepo.findByProviderAndEventId(provider, eventId);

    // If already processed, short-circuit
    if (webhookRecord && webhookRecord.status === 'PROCESSED') {
      logger.info(`Webhook event ${eventId} is already PROCESSED; skipping`, {
        eventId,
        provider,
      });
      return;
    }

    if (webhookRecord) {
      await this.webhookRepo.updateStatus(webhookRecord.id, 'PROCESSING');
    }

    try {
      // 2. Dispatch to Payment Service state machine
      await this.applyPaymentOperation(event.event_type, paymentId, event.payload, event.correlation_id);

      // 3. Mark Webhook Record PROCESSED
      const latencyMs = Math.round(performance.now() - startTime);
      if (webhookRecord) {
        await this.webhookRepo.updateStatus(webhookRecord.id, 'PROCESSED', {
          processedAt: new Date(),
          lastError: null,
        });
      }

      webhookMetrics.recordProcessed(latencyMs);
      logger.info(`Webhook event successfully processed: ${event.event_type} [${eventId}] in ${latencyMs}ms`, {
        event: 'webhook_consumer.success',
        eventId,
        eventType: event.event_type,
        paymentId,
        latencyMs,
      });
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      webhookMetrics.recordFailed();

      logger.error(`Webhook processing failure for event ${eventId}: ${errorMsg}`, {
        event: 'webhook_consumer.error',
        eventId,
        eventType: event.event_type,
        paymentId,
        error: { message: errorMsg },
      });

      // 4. Handle Retry vs DLQ
      await this.handleFailure(event, webhookRecord?.id, errorMsg);
      throw err;
    }
  }

  /**
   * Maps provider events to financial payment state machine operations.
   */
  private async applyPaymentOperation(
    eventType: string,
    paymentId: string,
    payload: Record<string, unknown>,
    correlationId: string
  ): Promise<void> {
    const data = (payload?.data as Record<string, any>) || {};
    const context = {
      correlationId,
      actorId: `webhook-processor:${payload?.provider || 'mockpay'}`,
    };

    switch (eventType) {
      case 'provider.payment.authorized': {
        try {
          await this.paymentService.authorizePayment(paymentId, context);
        } catch (err) {
          if (err instanceof InvalidStateTransitionError) {
            // Already authorized or captured; idempotent success
            logger.info(`Payment ${paymentId} already past AUTHORIZED state, idempotent no-op`);
            return;
          }
          throw err;
        }
        break;
      }

      case 'provider.payment.captured': {
        try {
          await this.paymentService.capturePayment(paymentId, context);
        } catch (err) {
          if (err instanceof InvalidStateTransitionError) {
            // Check if already captured / settled
            logger.info(`Payment ${paymentId} already CAPTURED or SETTLED, idempotent no-op`);
            return;
          }
          throw err;
        }
        break;
      }

      case 'provider.payment.failed': {
        try {
          await this.paymentService.failPayment(paymentId, context);
        } catch (err) {
          if (err instanceof InvalidStateTransitionError) {
            logger.info(`Payment ${paymentId} already in terminal state, idempotent no-op`);
            return;
          }
          throw err;
        }
        break;
      }

      case 'provider.payment.settled': {
        try {
          await this.paymentService.settlePayment(paymentId, context);
        } catch (err) {
          if (err instanceof InvalidStateTransitionError) {
            logger.info(`Payment ${paymentId} already SETTLED, idempotent no-op`);
            return;
          }
          throw err;
        }
        break;
      }

      case 'provider.refund.completed': {
        const amountMinor = data.amount_minor || 0;
        const reason = data.reason || 'Webhook refund completed';
        const idempotencyKey = `wh_refund_${payload.event_id || paymentId}`;
        try {
          await this.paymentService.refundPayment(paymentId, amountMinor, reason, idempotencyKey, context);
        } catch (err) {
          if (err instanceof InvalidStateTransitionError) {
            logger.info(`Payment ${paymentId} already REFUNDED, idempotent no-op`);
            return;
          }
          throw err;
        }
        break;
      }

      default:
        logger.warn(`Unhandled webhook event type: ${eventType}`);
        break;
    }
  }

  /**
   * Applies exponential backoff retry strategy and routes to DLQ if max retries exceeded.
   */
  private async handleFailure(
    event: EventEnvelope<Record<string, unknown>>,
    webhookId?: string,
    errorMsg?: string
  ): Promise<void> {
    const currentAttempts = webhookId
      ? ((await this.webhookRepo.findById(webhookId))?.attempts ?? 0) + 1
      : 1;
    const maxRetries = config.WEBHOOK_MAX_RETRIES;
    const eventId = (event.payload?.event_id as string) || event.event_id;

    if (currentAttempts < maxRetries) {
      // Exponential backoff: baseDelay * 2^(attempt - 1)
      const baseDelay = config.WEBHOOK_RETRY_BASE_DELAY_MS;
      const delayMs = baseDelay * Math.pow(2, currentAttempts - 1);
      const nextRetryAt = new Date(Date.now() + delayMs);

      if (webhookId) {
        await this.webhookRepo.updateStatus(webhookId, 'RETRY_PENDING', {
          attempts: currentAttempts,
          lastError: errorMsg,
          nextRetryAt,
        });
      }

      webhookMetrics.recordRetried();
      logger.info(`Webhook event [${eventId}] scheduled for retry #${currentAttempts} in ${delayMs}ms`, {
        event: 'webhook_consumer.retry_scheduled',
        eventId,
        attempt: currentAttempts,
        maxRetries,
        delayMs,
        nextRetryAt: nextRetryAt.toISOString(),
      });
    } else {
      // Exceeded max retries -> Move to Dead Letter Queue (DLQ)
      if (webhookId) {
        await this.webhookRepo.updateStatus(webhookId, 'DEAD_LETTERED', {
          attempts: currentAttempts,
          lastError: errorMsg,
        });
      }

      webhookMetrics.recordDeadLettered();

      // 1. Persist Dead Letter Event in PostgreSQL
      await this.deadLetterRepo.save({
        eventId,
        source: 'webhook-consumer',
        eventType: event.event_type,
        payload: {
          original_event_id: event.event_id,
          event_type: event.event_type,
          aggregate_id: event.aggregate_id,
          original_topic: KafkaTopics.WEBHOOK_EVENTS,
          attempts: currentAttempts,
          error: errorMsg,
          failed_at: new Date().toISOString(),
          original_payload: event.payload,
        },
        reason: errorMsg || 'Exceeded maximum retry attempts',
        attempts: currentAttempts,
        status: 'PENDING',
      });

      // 2. Publish to Kafka Dead Letter Topic
      try {
        await this.kafkaProducer.publishEvent(
          {
            event_id: `dlq_${event.event_id}`,
            event_type: 'webhook.dead_lettered',
            event_version: 1,
            occurred_at: new Date().toISOString(),
            producer: 'webhook-processor',
            correlation_id: event.correlation_id,
            aggregate_type: 'payment',
            aggregate_id: event.aggregate_id,
            payload: {
              original_event_id: event.event_id,
              event_type: event.event_type,
              aggregate_id: event.aggregate_id,
              original_topic: KafkaTopics.WEBHOOK_EVENTS,
              attempts: currentAttempts,
              error: errorMsg,
              failed_at: new Date().toISOString(),
              original_payload: event.payload,
            },
          },
          KafkaTopics.WEBHOOK_DLQ
        );
      } catch (err) {
        logger.error(`Failed to publish DLQ event to Kafka: ${eventId}`, {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }

      logger.warn(`Webhook event permanently failed and moved to DLQ: [${eventId}] after ${currentAttempts} attempts`, {
        event: 'webhook_consumer.dlq',
        eventId,
        attempts: currentAttempts,
        error: errorMsg,
      });
    }
  }
}
