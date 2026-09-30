import { IOutboxRepository, getOutboxRepository } from './outbox.repository.js';
import { KafkaProducerService, getKafkaProducerService } from '../kafka/kafka-producer.js';
import { EventEnvelope } from '../kafka/event-envelope.js';
import { logger } from '../../common/logger.js';
import { config } from '../../config/index.js';

export interface OutboxPublisherOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  maxRetries?: number;
}

export class OutboxPublisher {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly repository: IOutboxRepository = getOutboxRepository(),
    private readonly producer: KafkaProducerService = getKafkaProducerService(),
    private readonly options: OutboxPublisherOptions = {}
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    const interval = this.options.pollIntervalMs ?? config.OUTBOX_POLL_INTERVAL_MS;

    logger.info('Outbox publisher worker started', {
      intervalMs: interval,
      batchSize: this.options.batchSize ?? config.OUTBOX_BATCH_SIZE,
    });

    this.scheduleNext(interval);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Outbox publisher worker stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      try {
        await this.processBatch();
      } catch (err) {
        logger.error('Error during outbox publish loop', {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        if (this.isRunning) {
          this.scheduleNext(this.options.pollIntervalMs ?? config.OUTBOX_POLL_INTERVAL_MS);
        }
      }
    }, delayMs);
  }

  /**
   * Processes a single batch of unpublished outbox events.
   * Returns count of successfully published events.
   */
  public async processBatch(): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.isProcessing) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }
    this.isProcessing = true;

    const limit = this.options.batchSize ?? config.OUTBOX_BATCH_SIZE;
    const maxRetries = this.options.maxRetries ?? config.OUTBOX_MAX_RETRIES;

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const events = await this.repository.fetchUnpublished(limit);
      if (events.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      processed = events.length;

      for (const event of events) {
        try {
          const envelope: EventEnvelope<Record<string, unknown>> = {
            event_id: event.eventId,
            event_type: event.eventType,
            event_version: 1,
            occurred_at: event.createdAt.toISOString(),
            producer: 'payment-service',
            correlation_id: event.correlationId || 'unknown',
            aggregate_type: event.aggregateType,
            aggregate_id: event.aggregateId,
            payload: event.payload,
          };

          // 1. Publish to Kafka
          await this.producer.publishEvent(envelope, event.topic);

          // 2. Mark as published in outbox
          await this.repository.markPublished(event.id);
          succeeded++;

          logger.debug(`Outbox event published & marked: ${event.eventId}`, {
            id: event.id,
            eventType: event.eventType,
            aggregateId: event.aggregateId,
          });
        } catch (err) {
          failed++;
          const errorMessage = err instanceof Error ? err.message : String(err);
          const eventMaxRetries = event.maxAttempts || maxRetries;
          await this.repository.recordFailure(event.id, errorMessage, eventMaxRetries);

          logger.warn(`Failed publishing outbox event: ${event.eventId} (attempt ${event.attempts + 1}/${eventMaxRetries})`, {
            id: event.id,
            eventId: event.eventId,
            event: 'outbox_retry',
            error: errorMessage,
          });
        }
      }

      return { processed, succeeded, failed };
    } finally {
      this.isProcessing = false;
    }
  }
}

let activeOutboxPublisher: OutboxPublisher | null = null;

export function getOutboxPublisher(): OutboxPublisher {
  if (!activeOutboxPublisher) {
    activeOutboxPublisher = new OutboxPublisher();
  }
  return activeOutboxPublisher;
}
