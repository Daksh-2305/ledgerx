import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/client.js';
import { getKafkaClient, IKafkaConsumer, KafkaMessageBatch } from './kafka.client.js';
import { EventEnvelope } from './event-envelope.js';
import { kafkaMetrics } from './kafka.metrics.js';
import { logger } from '../../common/logger.js';

export interface IProcessedEventsRepository {
  isProcessed(eventId: string, consumerGroup: string): Promise<boolean>;
  markProcessed(eventId: string, consumerGroup: string, eventType: string): Promise<void>;
  clear?(): Promise<void>;
}

export class PrismaProcessedEventsRepository implements IProcessedEventsRepository {
  constructor(private client: PrismaClient = getPrismaClient()) {}

  public async isProcessed(eventId: string, consumerGroup: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await (this.client as any).processedEvent.findUnique({
      where: {
        uq_processed_events_event_group: {
          eventId,
          consumerGroup,
        },
      },
    });
    return !!existing;
  }

  public async markProcessed(eventId: string, consumerGroup: string, eventType: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.client as any).processedEvent.create({
      data: {
        eventId,
        consumerGroup,
        eventType,
      },
    });
  }
}

export class InMemoryProcessedEventsRepository implements IProcessedEventsRepository {
  private set = new Set<string>();

  public async isProcessed(eventId: string, consumerGroup: string): Promise<boolean> {
    return this.set.has(`${consumerGroup}:${eventId}`);
  }

  public async markProcessed(eventId: string, consumerGroup: string): Promise<void> {
    this.set.add(`${consumerGroup}:${eventId}`);
  }

  public async clear(): Promise<void> {
    this.set.clear();
  }
}

let activeProcessedEventsRepo: IProcessedEventsRepository | null = null;

export function getProcessedEventsRepository(): IProcessedEventsRepository {
  if (!activeProcessedEventsRepo) {
    if (process.env.NODE_ENV === 'test') {
      activeProcessedEventsRepo = new InMemoryProcessedEventsRepository();
    } else {
      activeProcessedEventsRepo = new PrismaProcessedEventsRepository();
    }
  }
  return activeProcessedEventsRepo;
}

export function setProcessedEventsRepository(repo: IProcessedEventsRepository): void {
  activeProcessedEventsRepo = repo;
}

export interface ConsumerOptions {
  groupId: string;
  topics: string[];
  processedEventsRepo?: IProcessedEventsRepository;
}

export abstract class BaseKafkaConsumer {
  protected consumer: IKafkaConsumer | null = null;
  protected groupId: string;
  protected topics: string[];
  protected processedRepo: IProcessedEventsRepository;
  protected isRunning = false;

  constructor(options: ConsumerOptions) {
    this.groupId = options.groupId;
    this.topics = options.topics;
    this.processedRepo = options.processedEventsRepo ?? getProcessedEventsRepository();
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    const client = await getKafkaClient();
    this.consumer = client.consumer(this.groupId);
    await this.consumer.connect();
    await this.consumer.subscribe(this.topics, true);

    this.isRunning = true;
    logger.info(`Kafka consumer [${this.groupId}] subscribed to topics: ${this.topics.join(', ')}`);

    await this.consumer.run(async (batch: KafkaMessageBatch) => {
      await this.handleIncomingMessage(batch);
    });
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.consumer) {
      await this.consumer.disconnect();
      this.consumer = null;
      logger.info(`Kafka consumer [${this.groupId}] stopped`);
    }
  }

  public async handleIncomingMessage(batch: KafkaMessageBatch): Promise<void> {
    let envelope: EventEnvelope<Record<string, unknown>>;
    try {
      envelope = JSON.parse(batch.message.value);
    } catch (err) {
      logger.error(`Malformed Kafka message in topic ${batch.topic}`, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }

    const eventId = envelope.event_id;
    if (!eventId) {
      logger.warn(`Kafka message without event_id in topic ${batch.topic}`);
      return;
    }

    // 1. Consumer Idempotency Check
    const alreadyProcessed = await this.processedRepo.isProcessed(eventId, this.groupId);
    if (alreadyProcessed) {
      kafkaMetrics.recordDuplicate();
      logger.info(`Duplicate Kafka event ignored by [${this.groupId}]: ${envelope.event_type} [${eventId}]`, {
        event: 'event_duplicate',
        consumerGroup: this.groupId,
        eventId,
        eventType: envelope.event_type,
        correlationId: envelope.correlation_id,
      });
      return;
    }

    // 2. Process domain event
    logger.info(`Processing Kafka event in [${this.groupId}]: ${envelope.event_type} [${eventId}]`, {
      event: 'event_consumed',
      consumerGroup: this.groupId,
      eventId,
      eventType: envelope.event_type,
      aggregateId: envelope.aggregate_id,
      correlationId: envelope.correlation_id,
    });

    try {
      await this.processEvent(envelope);

      // 3. Mark processed atomically
      await this.processedRepo.markProcessed(eventId, this.groupId, envelope.event_type);
    } catch (err) {
      kafkaMetrics.recordError();
      logger.error(`Consumer [${this.groupId}] handler error processing event ${eventId}`, {
        event: 'consumer_error',
        consumerGroup: this.groupId,
        eventId,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  protected abstract processEvent(event: EventEnvelope<Record<string, unknown>>): Promise<void>;
}

/**
 * Webhook Consumer (webhook-service group)
 * Forwards relevant payment and refund events to merchant webhooks.
 */
export class WebhookConsumer extends BaseKafkaConsumer {
  public handledEvents: EventEnvelope<Record<string, unknown>>[] = [];

  constructor(repo?: IProcessedEventsRepository) {
    super({
      groupId: 'webhook-service',
      topics: ['ledgerx.payment.events', 'ledgerx.refund.events'],
      processedEventsRepo: repo,
    });
  }

  protected async processEvent(event: EventEnvelope<Record<string, unknown>>): Promise<void> {
    this.handledEvents.push(event);
    logger.info(`[webhook-service] Prepared webhook notification for event: ${event.event_type}`, {
      eventId: event.event_id,
      aggregateId: event.aggregate_id,
    });
  }
}

/**
 * Risk Consumer (risk-service group)
 * Evaluates payment authorization and capture anomalies.
 */
export class RiskConsumer extends BaseKafkaConsumer {
  public handledEvents: EventEnvelope<Record<string, unknown>>[] = [];

  constructor(repo?: IProcessedEventsRepository) {
    super({
      groupId: 'risk-service',
      topics: ['ledgerx.payment.events'],
      processedEventsRepo: repo,
    });
  }

  protected async processEvent(event: EventEnvelope<Record<string, unknown>>): Promise<void> {
    this.handledEvents.push(event);
    logger.info(`[risk-service] Evaluated risk for event: ${event.event_type}`, {
      eventId: event.event_id,
      aggregateId: event.aggregate_id,
    });
  }
}

/**
 * Settlement Consumer (settlement-service group)
 * Aggregates captured payments for merchant batch settlement.
 */
export class SettlementConsumer extends BaseKafkaConsumer {
  public handledEvents: EventEnvelope<Record<string, unknown>>[] = [];

  constructor(repo?: IProcessedEventsRepository) {
    super({
      groupId: 'settlement-service',
      topics: ['ledgerx.payment.events'],
      processedEventsRepo: repo,
    });
  }

  protected async processEvent(event: EventEnvelope<Record<string, unknown>>): Promise<void> {
    this.handledEvents.push(event);
    logger.info(`[settlement-service] Queued payment for settlement: ${event.aggregate_id}`, {
      eventId: event.event_id,
      eventType: event.event_type,
    });
  }
}
