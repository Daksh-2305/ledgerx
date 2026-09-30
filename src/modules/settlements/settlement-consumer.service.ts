import {
  BaseKafkaConsumer,
  IProcessedEventsRepository,
  getProcessedEventsRepository,
} from '../../infra/kafka/kafka-consumer.js';
import { EventEnvelope, KafkaTopics, DomainEventTypes } from '../../infra/kafka/event-envelope.js';
import { SettlementService } from './settlement.service.js';
import { config } from '../../config/index.js';
import { logger } from '../../common/logger.js';

export interface SettlementConsumerDependencies {
  settlementService: SettlementService;
  processedRepo?: IProcessedEventsRepository;
}

export class SettlementConsumer extends BaseKafkaConsumer {
  private settlementService: SettlementService;

  constructor(deps: SettlementConsumerDependencies) {
    super({
      groupId: config.SETTLEMENT_CONSUMER_GROUP || 'ledgerx-settlement',
      topics: [KafkaTopics.SETTLEMENT_EVENTS],
      processedEventsRepo: deps.processedRepo ?? getProcessedEventsRepository(),
    });
    this.settlementService = deps.settlementService;
  }

  protected async processEvent(event: EventEnvelope<Record<string, unknown>>): Promise<void> {
    const eventType = event.event_type;
    const payload = event.payload as Record<string, any>;

    logger.info(`[ledgerx-settlement] Consumed event: ${eventType} [${event.event_id}]`, {
      event: 'settlement_consumer.received',
      eventId: event.event_id,
      eventType,
      aggregateId: event.aggregate_id,
    });

    switch (eventType) {
      case DomainEventTypes.SETTLEMENT_BATCH_CREATED:
      case 'settlement.batch.created': {
        const batchId = event.aggregate_id || payload.batch_id;
        if (!batchId) {
          logger.warn(`Missing batch_id in settlement event: [${event.event_id}]`);
          return;
        }

        logger.info(`Starting asynchronous processing for settlement batch: ${batchId}`);
        await this.settlementService.processBatch(
          batchId,
          {
            feeBps: payload.fee_bps,
          },
          { correlationId: event.correlation_id }
        );
        break;
      }

      default:
        // Informational events
        break;
    }
  }
}
