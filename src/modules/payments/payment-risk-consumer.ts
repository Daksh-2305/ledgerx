import { BaseKafkaConsumer, IProcessedEventsRepository, getProcessedEventsRepository } from '../../infra/kafka/kafka-consumer.js';
import { EventEnvelope, KafkaTopics } from '../../infra/kafka/event-envelope.js';
import { PaymentService } from './payment.service.js';
import { logger } from '../../common/logger.js';

export interface PaymentRiskConsumerOptions {
  paymentService: PaymentService;
  processedRepo?: IProcessedEventsRepository;
}

export class PaymentRiskDecisionConsumer extends BaseKafkaConsumer {
  private paymentService: PaymentService;

  constructor(options: PaymentRiskConsumerOptions) {
    super({
      groupId: 'payment-service-risk-handler',
      topics: [KafkaTopics.PAYMENT_EVENTS],
      processedEventsRepo: options.processedRepo ?? getProcessedEventsRepository(),
    });
    this.paymentService = options.paymentService;
  }

  protected async processEvent(event: EventEnvelope<Record<string, unknown>>): Promise<void> {
    if (event.event_type !== 'payment.risk.evaluated') {
      return;
    }

    const payload = event.payload as Record<string, any>;
    const paymentId = payload.payment_id || event.aggregate_id;
    const decision = payload.decision as 'ALLOW' | 'REVIEW' | 'BLOCK';
    const reasons = Array.isArray(payload.rules_triggered)
      ? payload.rules_triggered.map((r: any) => r.reason || r.rule_id).join('; ')
      : 'Evaluated by risk engine';

    logger.info(`Applying risk decision for payment ${paymentId}: ${decision}`, {
      paymentId,
      decision,
      riskScore: payload.risk_score,
      riskLevel: payload.risk_level,
    });

    try {
      await this.paymentService.applyRiskDecision(paymentId, decision, reasons, {
        correlationId: event.correlation_id,
        actorId: 'risk-engine',
      });
    } catch (err) {
      logger.error(`Error applying risk decision for payment ${paymentId}`, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }
}
