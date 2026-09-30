export interface KafkaMetricsSnapshot {
  kafka_connection_status: 'CONNECTED' | 'DISCONNECTED' | 'DEGRADED';
  kafka_errors: number;
  events_published_total: number;
  events_consumed_total: number;
  events_duplicate_total: number;
  outbox_pending_count: number;
  outbox_published_total: number;
  outbox_failed_total: number;
}

class KafkaMetricsCollector {
  private connectionStatus: 'CONNECTED' | 'DISCONNECTED' | 'DEGRADED' = 'DISCONNECTED';
  private errors = 0;
  private eventsPublished = 0;
  private eventsConsumed = 0;
  private eventsDuplicate = 0;
  private outboxPending = 0;
  private outboxPublished = 0;
  private outboxFailed = 0;

  public setConnectionStatus(status: 'CONNECTED' | 'DISCONNECTED' | 'DEGRADED'): void {
    this.connectionStatus = status;
  }

  public recordError(): void {
    this.errors++;
  }

  public recordPublished(count = 1): void {
    this.eventsPublished += count;
  }

  public recordConsumed(count = 1): void {
    this.eventsConsumed += count;
  }

  public recordDuplicate(count = 1): void {
    this.eventsDuplicate += count;
  }

  public setOutboxPending(count: number): void {
    this.outboxPending = count;
  }

  public recordOutboxPublished(count = 1): void {
    this.outboxPublished += count;
  }

  public recordOutboxFailed(count = 1): void {
    this.outboxFailed += count;
  }

  public getSnapshot(): KafkaMetricsSnapshot {
    return {
      kafka_connection_status: this.connectionStatus,
      kafka_errors: this.errors,
      events_published_total: this.eventsPublished,
      events_consumed_total: this.eventsConsumed,
      events_duplicate_total: this.eventsDuplicate,
      outbox_pending_count: this.outboxPending,
      outbox_published_total: this.outboxPublished,
      outbox_failed_total: this.outboxFailed,
    };
  }

  public reset(): void {
    this.connectionStatus = 'DISCONNECTED';
    this.errors = 0;
    this.eventsPublished = 0;
    this.eventsConsumed = 0;
    this.eventsDuplicate = 0;
    this.outboxPending = 0;
    this.outboxPublished = 0;
    this.outboxFailed = 0;
  }
}

export const kafkaMetrics = new KafkaMetricsCollector();
