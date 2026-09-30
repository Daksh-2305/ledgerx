export class ReconciliationMetrics {
  private static instance: ReconciliationMetrics;

  private runsTotal = 0;
  private runsSuccess = 0;
  private runsFailed = 0;
  private recordsProcessed = 0;
  private recordsMatched = 0;
  private recordsMismatched = 0;
  private missingInternal = 0;
  private missingExternal = 0;
  private duplicates = 0;
  private totalProcessingDurationMs = 0;
  private lastProcessingDurationMs = 0;

  public static getInstance(): ReconciliationMetrics {
    if (!ReconciliationMetrics.instance) {
      ReconciliationMetrics.instance = new ReconciliationMetrics();
    }
    return ReconciliationMetrics.instance;
  }

  public recordRunCreated(): void {
    this.runsTotal++;
  }

  public recordRunSuccess(durationMs: number): void {
    this.runsSuccess++;
    this.totalProcessingDurationMs += durationMs;
    this.lastProcessingDurationMs = durationMs;
  }

  public recordRunFailed(durationMs: number): void {
    this.runsFailed++;
    this.totalProcessingDurationMs += durationMs;
    this.lastProcessingDurationMs = durationMs;
  }

  public recordProcessedCounts(counts: {
    processed: number;
    matched: number;
    mismatched: number;
    missingInternal: number;
    missingExternal: number;
    duplicates: number;
  }): void {
    this.recordsProcessed += counts.processed;
    this.recordsMatched += counts.matched;
    this.recordsMismatched += counts.mismatched;
    this.missingInternal += counts.missingInternal;
    this.missingExternal += counts.missingExternal;
    this.duplicates += counts.duplicates;
  }

  public getMetrics(): {
    reconciliation_runs_total: number;
    reconciliation_runs_success: number;
    reconciliation_runs_failed: number;
    records_processed: number;
    records_matched: number;
    records_mismatched: number;
    missing_internal: number;
    missing_external: number;
    duplicates: number;
    processing_duration_total_ms: number;
    processing_duration_last_ms: number;
    average_duration_ms: number;
  } {
    const totalFinished = this.runsSuccess + this.runsFailed;
    const avgDuration = totalFinished > 0 ? Math.round(this.totalProcessingDurationMs / totalFinished) : 0;
    return {
      reconciliation_runs_total: this.runsTotal,
      reconciliation_runs_success: this.runsSuccess,
      reconciliation_runs_failed: this.runsFailed,
      records_processed: this.recordsProcessed,
      records_matched: this.recordsMatched,
      records_mismatched: this.recordsMismatched,
      missing_internal: this.missingInternal,
      missing_external: this.missingExternal,
      duplicates: this.duplicates,
      processing_duration_total_ms: this.totalProcessingDurationMs,
      processing_duration_last_ms: this.lastProcessingDurationMs,
      average_duration_ms: avgDuration,
    };
  }

  public reset(): void {
    this.runsTotal = 0;
    this.runsSuccess = 0;
    this.runsFailed = 0;
    this.recordsProcessed = 0;
    this.recordsMatched = 0;
    this.recordsMismatched = 0;
    this.missingInternal = 0;
    this.missingExternal = 0;
    this.duplicates = 0;
    this.totalProcessingDurationMs = 0;
    this.lastProcessingDurationMs = 0;
  }
}

export const reconciliationMetrics = ReconciliationMetrics.getInstance();
