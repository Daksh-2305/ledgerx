import {
  BaseKafkaConsumer,
  IProcessedEventsRepository,
  getProcessedEventsRepository,
} from '../../infra/kafka/kafka-consumer.js';
import { EventEnvelope, KafkaTopics, DomainEventTypes } from '../../infra/kafka/event-envelope.js';
import { ReconciliationService } from './reconciliation.service.js';
import { config } from '../../config/index.js';
import { logger } from '../../common/logger.js';

export interface ReconciliationConsumerDependencies {
  reconciliationService: ReconciliationService;
  processedRepo?: IProcessedEventsRepository;
}

export class ReconciliationConsumer extends BaseKafkaConsumer {
  private reconciliationService: ReconciliationService;

  constructor(deps: ReconciliationConsumerDependencies) {
    super({
      groupId: config.RECONCILIATION_CONSUMER_GROUP || 'ledgerx-reconciliation',
      topics: [KafkaTopics.RECONCILIATION_EVENTS],
      processedEventsRepo: deps.processedRepo ?? getProcessedEventsRepository(),
    });
    this.reconciliationService = deps.reconciliationService;
  }

  protected async processEvent(event: EventEnvelope<Record<string, unknown>>): Promise<void> {
    const eventType = event.event_type;
    const payload = event.payload as Record<string, any>;

    logger.info(`[ledgerx-reconciliation] Consumed event: ${eventType} [${event.event_id}]`, {
      event: 'reconciliation_consumer.received',
      eventId: event.event_id,
      eventType,
      aggregateId: event.aggregate_id,
    });

    switch (eventType) {
      case DomainEventTypes.RECONCILIATION_RUN_CREATED:
      case 'reconciliation.run.created': {
        const runId = event.aggregate_id || payload.run_id;
        if (!runId) {
          logger.warn(`Missing run_id in reconciliation event: [${event.event_id}]`);
          return;
        }

        logger.info(`Starting asynchronous execution for reconciliation run: ${runId}`);
        await this.reconciliationService.executeRun(runId, event.correlation_id);
        break;
      }

      default:
        // Other events (started, completed, etc.) are informational
        break;
    }
  }
}
