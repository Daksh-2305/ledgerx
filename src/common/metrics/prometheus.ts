/**
 * LedgerX Production Prometheus Metrics Registry
 * Implements standard OpenMetrics / Prometheus exposition format.
 * Strictly avoids high-cardinality labels (payment_id, user_id, email, etc.)
 */

export class Counter {
  private values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = []
  ) {}

  public inc(labels: Record<string, string> = {}, value: number = 1): void {
    if (value < 0) throw new Error('Counter value cannot decrease');
    const key = this.formatKey(labels);
    const curr = this.values.get(key) || 0;
    this.values.set(key, curr + value);
  }

  public get(labels: Record<string, string> = {}): number {
    return this.values.get(this.formatKey(labels)) || 0;
  }

  public reset(): void {
    this.values.clear();
  }

  private formatKey(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
  }

  public toPrometheusString(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];

    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
      return lines.join('\n');
    }

    for (const [labels, val] of this.values.entries()) {
      if (labels) {
        lines.push(`${this.name}{${labels}} ${val}`);
      } else {
        lines.push(`${this.name} ${val}`);
      }
    }

    return lines.join('\n');
  }
}

export class Gauge {
  private values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = []
  ) {}

  public set(value: number, labels: Record<string, string> = {}): void {
    const key = this.formatKey(labels);
    this.values.set(key, value);
  }

  public inc(labels: Record<string, string> = {}, value: number = 1): void {
    const key = this.formatKey(labels);
    const curr = this.values.get(key) || 0;
    this.values.set(key, curr + value);
  }

  public dec(labels: Record<string, string> = {}, value: number = 1): void {
    const key = this.formatKey(labels);
    const curr = this.values.get(key) || 0;
    this.values.set(key, curr - value);
  }

  public get(labels: Record<string, string> = {}): number {
    return this.values.get(this.formatKey(labels)) || 0;
  }

  public reset(): void {
    this.values.clear();
  }

  private formatKey(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
  }

  public toPrometheusString(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];

    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
      return lines.join('\n');
    }

    for (const [labels, val] of this.values.entries()) {
      if (labels) {
        lines.push(`${this.name}{${labels}} ${val}`);
      } else {
        lines.push(`${this.name} ${val}`);
      }
    }

    return lines.join('\n');
  }
}

export class Histogram {
  private counts = new Map<string, number>();
  private sums = new Map<string, number>();
  private buckets = new Map<string, Map<number, number>>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
    public readonly bucketBounds: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ) {}

  public observe(value: number, labels: Record<string, string> = {}): void {
    const key = this.formatKey(labels);

    // Sum and count
    this.sums.set(key, (this.sums.get(key) || 0) + value);
    this.counts.set(key, (this.counts.get(key) || 0) + 1);

    // Buckets
    let bMap = this.buckets.get(key);
    if (!bMap) {
      bMap = new Map();
      for (const b of this.bucketBounds) {
        bMap.set(b, 0);
      }
      this.buckets.set(key, bMap);
    }

    for (const b of this.bucketBounds) {
      if (value <= b) {
        bMap.set(b, (bMap.get(b) || 0) + 1);
      }
    }
  }

  public reset(): void {
    this.counts.clear();
    this.sums.clear();
    this.buckets.clear();
  }

  private formatKey(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
  }

  public toPrometheusString(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    if (this.counts.size === 0) {
      lines.push(`${this.name}_count 0`);
      lines.push(`${this.name}_sum 0`);
      return lines.join('\n');
    }

    for (const [key, count] of this.counts.entries()) {
      const sum = this.sums.get(key) || 0;
      const bMap = this.buckets.get(key);
      const labelPrefix = key ? `${key},` : '';

      if (bMap) {
        let cumulative = 0;
        for (const b of this.bucketBounds) {
          cumulative += bMap.get(b) || 0;
          lines.push(`${this.name}_bucket{${labelPrefix}le="${b}"} ${cumulative}`);
        }
      }
      lines.push(`${this.name}_bucket{${labelPrefix}le="+Inf"} ${count}`);
      lines.push(`${this.name}_sum{${key}} ${sum.toFixed(4)}`);
      lines.push(`${this.name}_count{${key}} ${count}`);
    }

    return lines.join('\n');
  }
}

/**
 * Global Prometheus Metrics Registry for LedgerX Production Platform
 */
export class PrometheusRegistry {
  private static instance: PrometheusRegistry;

  // HTTP Metrics
  public readonly httpRequestsTotal = new Counter(
    'http_requests_total',
    'Total count of handled HTTP requests',
    ['method', 'route', 'status']
  );
  public readonly httpRequestDurationSeconds = new Histogram(
    'http_request_duration_seconds',
    'Histogram of HTTP request latency in seconds',
    ['method', 'route']
  );

  // Payment Metrics
  public readonly paymentCreatedTotal = new Counter('payment_created_total', 'Total payments initiated in CREATED state');
  public readonly paymentAuthorizedTotal = new Counter('payment_authorized_total', 'Total payments transitioned to AUTHORIZED');
  public readonly paymentCapturedTotal = new Counter('payment_captured_total', 'Total payments transitioned to CAPTURED');
  public readonly paymentFailedTotal = new Counter('payment_failed_total', 'Total payments that entered terminal FAILED state');
  public readonly paymentCancelledTotal = new Counter('payment_cancelled_total', 'Total payments CANCELLED');

  // Refund Metrics
  public readonly refundCreatedTotal = new Counter('refund_created_total', 'Total refund requests submitted');
  public readonly refundCompletedTotal = new Counter('refund_completed_total', 'Total compensating refunds successfully executed');
  public readonly refundFailedTotal = new Counter('refund_failed_total', 'Total refunds rejected or failed');

  // Double-Entry Ledger Metrics
  public readonly ledgerTransactionsTotal = new Counter(
    'ledger_transactions_total',
    'Total balanced double-entry transactions posted',
    ['type']
  );
  public readonly ledgerIntegrityFailuresTotal = new Counter(
    'ledger_integrity_failures_total',
    'Count of invariant integrity violations detected'
  );

  // Webhook Metrics
  public readonly webhookReceivedTotal = new Counter('webhook_received_total', 'Total external webhooks received', ['provider']);
  public readonly webhookProcessedTotal = new Counter('webhook_processed_total', 'Total external webhooks successfully processed', ['provider']);
  public readonly webhookFailedTotal = new Counter('webhook_failed_total', 'Total external webhooks failed during processing', ['provider']);
  public readonly webhookDlqTotal = new Counter('webhook_dlq_total', 'Total exhausted webhooks sent to dead-letter queue', ['provider']);

  // Kafka & Streaming
  public readonly messagesProcessedTotal = new Counter('messages_processed_total', 'Kafka messages successfully consumed', ['topic']);
  public readonly consumerErrorsTotal = new Counter('consumer_errors_total', 'Total Kafka consumer processing errors', ['topic']);
  public readonly processingLatencySeconds = new Histogram(
    'processing_latency_seconds',
    'Latency of asynchronous worker processing',
    ['consumer_group']
  );

  // Reconciliation Metrics
  public readonly reconciliationRunsTotal = new Counter('reconciliation_runs_total', 'Total reconciliation runs executed', ['status']);
  public readonly reconciliationDiscrepanciesTotal = new Counter('reconciliation_discrepancies_total', 'Total discrepancies surfaced', ['result']);

  // Settlement Metrics
  public readonly settlementBatchesTotal = new Counter('settlement_batches_total', 'Total settlement batches created', ['status']);
  public readonly settlementFailuresTotal = new Counter('settlement_failures_total', 'Total settlement batches in failed state');
  public readonly settlementAmountTotal = new Counter('settlement_amount_minor_total', 'Cumulative net settlement minor units disbursed', ['currency']);

  // Risk Engine Metrics
  public readonly riskAssessmentsTotal = new Counter('risk_assessments_total', 'Total payments evaluated by risk engine', ['decision']);
  public readonly blockedPaymentsTotal = new Counter('blocked_payments_total', 'Total payments blocked by rule evaluation');
  public readonly reviewPaymentsTotal = new Counter('review_payments_total', 'Total payments flagged for manual review');

  // Infrastructure Error Metrics
  public readonly databaseConnectionErrorsTotal = new Counter('database_connection_errors_total', 'Database connectivity or transaction errors');
  public readonly redisErrorsTotal = new Counter('redis_errors_total', 'Redis infrastructure errors or fallback triggers');
  public readonly kafkaErrorsTotal = new Counter('kafka_errors_total', 'Kafka producer or broker connection errors');

  public static getInstance(): PrometheusRegistry {
    if (!PrometheusRegistry.instance) {
      PrometheusRegistry.instance = new PrometheusRegistry();
    }
    return PrometheusRegistry.instance;
  }

  public getMetricsString(): string {
    const metrics: Array<{ toPrometheusString(): string }> = [
      this.httpRequestsTotal,
      this.httpRequestDurationSeconds,
      this.paymentCreatedTotal,
      this.paymentAuthorizedTotal,
      this.paymentCapturedTotal,
      this.paymentFailedTotal,
      this.paymentCancelledTotal,
      this.refundCreatedTotal,
      this.refundCompletedTotal,
      this.refundFailedTotal,
      this.ledgerTransactionsTotal,
      this.ledgerIntegrityFailuresTotal,
      this.webhookReceivedTotal,
      this.webhookProcessedTotal,
      this.webhookFailedTotal,
      this.webhookDlqTotal,
      this.messagesProcessedTotal,
      this.consumerErrorsTotal,
      this.processingLatencySeconds,
      this.reconciliationRunsTotal,
      this.reconciliationDiscrepanciesTotal,
      this.settlementBatchesTotal,
      this.settlementFailuresTotal,
      this.settlementAmountTotal,
      this.riskAssessmentsTotal,
      this.blockedPaymentsTotal,
      this.reviewPaymentsTotal,
      this.databaseConnectionErrorsTotal,
      this.redisErrorsTotal,
      this.kafkaErrorsTotal,
    ];

    return metrics.map((m) => m.toPrometheusString()).join('\n\n') + '\n';
  }

  public resetAll(): void {
    const metrics: Array<{ reset(): void }> = [
      this.httpRequestsTotal,
      this.httpRequestDurationSeconds,
      this.paymentCreatedTotal,
      this.paymentAuthorizedTotal,
      this.paymentCapturedTotal,
      this.paymentFailedTotal,
      this.paymentCancelledTotal,
      this.refundCreatedTotal,
      this.refundCompletedTotal,
      this.refundFailedTotal,
      this.ledgerTransactionsTotal,
      this.ledgerIntegrityFailuresTotal,
      this.webhookReceivedTotal,
      this.webhookProcessedTotal,
      this.webhookFailedTotal,
      this.webhookDlqTotal,
      this.messagesProcessedTotal,
      this.consumerErrorsTotal,
      this.processingLatencySeconds,
      this.reconciliationRunsTotal,
      this.reconciliationDiscrepanciesTotal,
      this.settlementBatchesTotal,
      this.settlementFailuresTotal,
      this.settlementAmountTotal,
      this.riskAssessmentsTotal,
      this.blockedPaymentsTotal,
      this.reviewPaymentsTotal,
      this.databaseConnectionErrorsTotal,
      this.redisErrorsTotal,
      this.kafkaErrorsTotal,
    ];

    for (const m of metrics) {
      m.reset();
    }
  }
}

export const prometheusRegistry = PrometheusRegistry.getInstance();
