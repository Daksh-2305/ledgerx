import { getKafkaClient, IKafkaProducer } from './kafka.client.js';
import { EventEnvelope, getTopicForEventType } from './event-envelope.js';
import { logger } from '../../common/logger.js';

export interface PublishResult {
  eventId: string;
  topic: string;
  partitionKey: string;
  publishedAt: string;
}

export class KafkaProducerService {
  private producer: IKafkaProducer | null = null;

  constructor(private producerGetter?: () => Promise<IKafkaProducer>) {}

  private async getProducer(): Promise<IKafkaProducer> {
    if (this.producer && this.producer.isAvailable()) {
      return this.producer;
    }
    if (this.producerGetter) {
      this.producer = await this.producerGetter();
      if (!this.producer.isAvailable()) {
        await this.producer.connect();
      }
      return this.producer;
    }

    const client = await getKafkaClient();
    this.producer = client.producer();
    if (!this.producer.isAvailable()) {
      await this.producer.connect();
    }
    return this.producer;
  }

  /**
   * Publishes a standardized domain event envelope to Kafka with partition key routing.
   */
  public async publishEvent<T extends Record<string, unknown>>(
    event: EventEnvelope<T>,
    customTopic?: string
  ): Promise<PublishResult> {
    const topic = customTopic || getTopicForEventType(event.event_type);
    const partitionKey = event.aggregate_id; // Ensures partition-local ordering per aggregate (e.g. paymentId)
    const serializedPayload = JSON.stringify(event);

    try {
      const producer = await this.getProducer();
      await producer.send({
        topic,
        messages: [
          {
            key: partitionKey,
            value: serializedPayload,
            headers: {
              'x-event-id': event.event_id,
              'x-event-type': event.event_type,
              'x-correlation-id': event.correlation_id,
              'x-producer': event.producer,
              'x-aggregate-type': event.aggregate_type,
              'x-aggregate-id': event.aggregate_id,
            },
          },
        ],
      });

      const publishedAt = new Date().toISOString();
      logger.info(`Kafka event published: ${event.event_type} [${event.event_id}] -> ${topic}`, {
        correlationId: event.correlation_id,
        event: 'event_published',
        eventId: event.event_id,
        eventType: event.event_type,
        aggregateId: event.aggregate_id,
        topic,
        partitionKey,
      });

      return {
        eventId: event.event_id,
        topic,
        partitionKey,
        publishedAt,
      };
    } catch (err) {
      logger.error(`Failed to publish Kafka event: ${event.event_type} [${event.event_id}]`, {
        correlationId: event.correlation_id,
        event: 'event_publish_failed',
        eventId: event.event_id,
        eventType: event.event_type,
        aggregateId: event.aggregate_id,
        topic,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
  }
}

let activeProducerService: KafkaProducerService | null = null;

export function getKafkaProducerService(): KafkaProducerService {
  if (!activeProducerService) {
    activeProducerService = new KafkaProducerService();
  }
  return activeProducerService;
}
