export interface WebhookMetricsSnapshot {
  webhooks_received: number;
  webhooks_valid: number;
  webhooks_invalid: number;
  webhooks_processed: number;
  webhooks_failed: number;
  webhooks_retried: number;
  webhooks_dead_lettered: number;
  duplicate_webhooks: number;
  webhook_processing_latency_ms: number;
}

export class WebhookMetrics {
  private receivedCount = 0;
  private validCount = 0;
  private invalidCount = 0;
  private processedCount = 0;
  private failedCount = 0;
  private retriedCount = 0;
  private deadLetteredCount = 0;
  private duplicateCount = 0;
  private latencies: number[] = [];

  public recordReceived(): void {
    this.receivedCount++;
  }

  public recordValid(): void {
    this.validCount++;
  }

  public recordInvalid(): void {
    this.invalidCount++;
  }

  public recordProcessed(latencyMs?: number): void {
    this.processedCount++;
    if (typeof latencyMs === 'number') {
      this.latencies.push(latencyMs);
      if (this.latencies.length > 500) {
        this.latencies.shift();
      }
    }
  }

  public recordFailed(): void {
    this.failedCount++;
  }

  public recordRetried(): void {
    this.retriedCount++;
  }

  public recordDeadLettered(): void {
    this.deadLetteredCount++;
  }

  public recordDuplicate(): void {
    this.duplicateCount++;
  }

  public getSnapshot(): WebhookMetricsSnapshot {
    const avgLatency =
      this.latencies.length > 0
        ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length)
        : 0;

    return {
      webhooks_received: this.receivedCount,
      webhooks_valid: this.validCount,
      webhooks_invalid: this.invalidCount,
      webhooks_processed: this.processedCount,
      webhooks_failed: this.failedCount,
      webhooks_retried: this.retriedCount,
      webhooks_dead_lettered: this.deadLetteredCount,
      duplicate_webhooks: this.duplicateCount,
      webhook_processing_latency_ms: avgLatency,
    };
  }

  public reset(): void {
    this.receivedCount = 0;
    this.validCount = 0;
    this.invalidCount = 0;
    this.processedCount = 0;
    this.failedCount = 0;
    this.retriedCount = 0;
    this.deadLetteredCount = 0;
    this.duplicateCount = 0;
    this.latencies = [];
  }
}

export const webhookMetrics = new WebhookMetrics();
