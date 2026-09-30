import crypto from 'node:crypto';

export interface EventEnvelope<T = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  event_version: number;
  occurred_at: string;
  producer: string;
  correlation_id: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: T;
}

export const EventTypes = {
  // Payment lifecycle events
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_PENDING: 'payment.pending',
  PAYMENT_AUTHORIZED: 'payment.authorized',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_CANCELLED: 'payment.cancelled',
  PAYMENT_SETTLED: 'payment.settled',

  // Refund lifecycle events
  REFUND_CREATED: 'refund.created',
  REFUND_COMPLETED: 'refund.completed',
  REFUND_FAILED: 'refund.failed',

  // Provider / Webhook events (Milestone 7)
  PROVIDER_PAYMENT_AUTHORIZED: 'provider.payment.authorized',
  PROVIDER_PAYMENT_CAPTURED: 'provider.payment.captured',
  PROVIDER_PAYMENT_FAILED: 'provider.payment.failed',
  PROVIDER_REFUND_COMPLETED: 'provider.refund.completed',
  PROVIDER_PAYMENT_SETTLED: 'provider.payment.settled',

  // Risk Engine events (Milestone 8)
  PAYMENT_RISK_EVALUATED: 'payment.risk.evaluated',

  // Reconciliation events (Milestone 9)
  RECONCILIATION_RUN_CREATED: 'reconciliation.run.created',
  RECONCILIATION_RUN_STARTED: 'reconciliation.run.started',
  RECONCILIATION_RUN_COMPLETED: 'reconciliation.run.completed',
  RECONCILIATION_RUN_FAILED: 'reconciliation.run.failed',
  DISCREPANCY_CREATED: 'discrepancy.created',
  DISCREPANCY_INVESTIGATED: 'discrepancy.investigated',
  DISCREPANCY_RESOLVED: 'discrepancy.resolved',
  DISCREPANCY_WAIVED: 'discrepancy.waived',

  // Settlement lifecycle events (Milestone 10)
  SETTLEMENT_BATCH_CREATED: 'settlement.batch.created',
  SETTLEMENT_PROCESSING_STARTED: 'settlement.processing.started',
  SETTLEMENT_RECONCILED: 'settlement.reconciled',
  SETTLEMENT_READY: 'settlement.ready',
  SETTLEMENT_STARTED: 'settlement.started',
  SETTLEMENT_COMPLETED: 'settlement.completed',
  SETTLEMENT_FAILED: 'settlement.failed',
} as const;

export const DomainEventTypes = EventTypes;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

export const KafkaTopics = {
  PAYMENT_EVENTS: 'ledgerx.payment.events',
  REFUND_EVENTS: 'ledgerx.refund.events',
  SETTLEMENT_EVENTS: 'ledgerx.settlement.events',
  DOMAIN_EVENTS: 'ledgerx.domain.events',
  WEBHOOK_EVENTS: 'ledgerx.webhook.events',
  WEBHOOK_DLQ: 'ledgerx.webhook.dlq',
  RECONCILIATION_EVENTS: 'ledgerx.reconciliation.events',
} as const;

export type KafkaTopic = (typeof KafkaTopics)[keyof typeof KafkaTopics];

/**
 * Resolves the appropriate Kafka topic for a given domain event type.
 */
export function getTopicForEventType(eventType: string): string {
  if (eventType.startsWith('payment.')) {
    return KafkaTopics.PAYMENT_EVENTS;
  }
  if (eventType.startsWith('refund.')) {
    return KafkaTopics.REFUND_EVENTS;
  }
  if (eventType.startsWith('settlement.')) {
    return KafkaTopics.SETTLEMENT_EVENTS;
  }
  if (eventType.startsWith('provider.') || eventType.startsWith('webhook.')) {
    return KafkaTopics.WEBHOOK_EVENTS;
  }
  if (eventType.startsWith('reconciliation.') || eventType.startsWith('discrepancy.')) {
    return KafkaTopics.RECONCILIATION_EVENTS;
  }
  return KafkaTopics.DOMAIN_EVENTS;
}

export interface CreateEventOptions<T> {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: T;
  correlationId?: string;
  producer?: string;
  eventVersion?: number;
}

/**
 * Creates a standard validated LedgerX event envelope.
 */
export function createEventEnvelope<T extends Record<string, unknown>>(
  options: CreateEventOptions<T>
): EventEnvelope<T> {
  return {
    event_id: `evt_${crypto.randomUUID()}`,
    event_type: options.eventType,
    event_version: options.eventVersion ?? 1,
    occurred_at: new Date().toISOString(),
    producer: options.producer ?? 'payment-service',
    correlation_id: options.correlationId ?? `corr_${crypto.randomBytes(4).toString('hex')}`,
    aggregate_type: options.aggregateType,
    aggregate_id: options.aggregateId,
    payload: sanitizePayload(options.payload),
  };
}

/**
 * Ensures sensitive data (passwords, card credentials, API keys) are stripped before publishing.
 */
function sanitizePayload<T extends Record<string, unknown>>(payload: T): T {
  const sensitiveKeys = ['password', 'password_hash', 'cvv', 'card_number', 'secret', 'api_key'];
  const sanitized = { ...payload } as Record<string, unknown>;

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
      delete sanitized[key];
    }
  }

  return sanitized as T;
}
