import { BaseKafkaConsumer, IProcessedEventsRepository, getProcessedEventsRepository } from '../../infra/kafka/kafka-consumer.js';
import { EventEnvelope, KafkaTopics } from '../../infra/kafka/event-envelope.js';
import { RiskService } from './risk.service.js';
import { config } from '../../config/index.js';
import { logger } from '../../common/logger.js';
import { recordPaymentFailureSignal, recordRefundSignal } from './risk.rules.js';
import { IRedisClient, getRedisClient } from '../../infra/redis/redis.client.js';

export interface RiskConsumerDependencies {
  riskService: RiskService;
  processedRepo?: IProcessedEventsRepository;
  redisClient?: IRedisClient;
}

export class RiskEngineConsumer extends BaseKafkaConsumer {
  private riskService: RiskService;
  private redisClient?: IRedisClient;

  constructor(deps: RiskConsumerDependencies) {
    super({
      groupId: config.RISK_CONSUMER_GROUP,
      topics: [KafkaTopics.PAYMENT_EVENTS, KafkaTopics.REFUND_EVENTS],
      processedEventsRepo: deps.processedRepo ?? getProcessedEventsRepository(),
    });
    this.riskService = deps.riskService;
    this.redisClient = deps.redisClient;
  }

  protected async processEvent(event: EventEnvelope<Record<string, unknown>>): Promise<void> {
    const eventType = event.event_type;
    const payload = event.payload as Record<string, any>;

    logger.info(`[ledgerx-risk-engine] Consumed event: ${eventType} [${event.event_id}]`, {
      event: 'risk_consumer.received',
      eventId: event.event_id,
      eventType,
      aggregateId: event.aggregate_id,
    });

    switch (eventType) {
      case 'payment.created': {
        const paymentId = event.aggregate_id || payload.id;
        const merchantId = payload.merchant_id || payload.merchantId;
        const customerId = payload.customer_id || payload.customerId;
        const amountMinor = payload.amount_minor ?? payload.amountMinor ?? 0;
        const currency = payload.currency || 'INR';

        if (!paymentId || !merchantId) {
          logger.warn(`Missing required payment attributes for risk evaluation: [${event.event_id}]`);
          return;
        }

        await this.riskService.evaluatePayment({
          paymentId,
          merchantId,
          customerId: customerId || 'anonymous_customer',
          amountMinor,
          currency,
          occurredAt: new Date(event.occurred_at),
          correlationId: event.correlation_id,
          metadata: payload.metadata,
        });
        break;
      }

      case 'payment.failed': {
        const customerId = payload.customer_id || payload.customerId;
        if (customerId) {
          const redis = this.redisClient ?? (await getRedisClient());
          await recordPaymentFailureSignal(customerId, redis);
        }
        break;
      }

      case 'refund.completed': {
        const merchantId = payload.merchant_id || payload.merchantId;
        if (merchantId) {
          const redis = this.redisClient ?? (await getRedisClient());
          await recordRefundSignal(merchantId, redis);
        }
        break;
      }

      default:
        // Other events (e.g. payment.authorized, payment.captured, payment.risk.evaluated)
        // are ignored by the risk engine consumer to avoid loops
        break;
    }
  }
}
