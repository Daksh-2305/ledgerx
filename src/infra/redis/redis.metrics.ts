/**
 * Redis Observability & Telemetry Metrics (Milestone 5)
 */

export interface RedisMetricsSnapshot {
  redis_connection_status: 'CONNECTED' | 'DISCONNECTED' | 'FALLBACK';
  redis_errors: number;
  cache_hits: number;
  cache_misses: number;
  lock_acquisition_success: number;
  lock_acquisition_failure: number;
  rate_limit_blocks: number;
}

class RedisMetricsCollector {
  private status: 'CONNECTED' | 'DISCONNECTED' | 'FALLBACK' = 'DISCONNECTED';
  private errorsCount = 0;
  private cacheHitsCount = 0;
  private cacheMissesCount = 0;
  private lockAcquisitionSuccessCount = 0;
  private lockAcquisitionFailureCount = 0;
  private rateLimitBlocksCount = 0;

  public setConnectionStatus(status: 'CONNECTED' | 'DISCONNECTED' | 'FALLBACK'): void {
    this.status = status;
  }

  public recordError(): void {
    this.errorsCount++;
  }

  public recordCacheHit(): void {
    this.cacheHitsCount++;
  }

  public recordCacheMiss(): void {
    this.cacheMissesCount++;
  }

  public recordLockSuccess(): void {
    this.lockAcquisitionSuccessCount++;
  }

  public recordLockFailure(): void {
    this.lockAcquisitionFailureCount++;
  }

  public recordRateLimitBlock(): void {
    this.rateLimitBlocksCount++;
  }

  public getSnapshot(): RedisMetricsSnapshot {
    return {
      redis_connection_status: this.status,
      redis_errors: this.errorsCount,
      cache_hits: this.cacheHitsCount,
      cache_misses: this.cacheMissesCount,
      lock_acquisition_success: this.lockAcquisitionSuccessCount,
      lock_acquisition_failure: this.lockAcquisitionFailureCount,
      rate_limit_blocks: this.rateLimitBlocksCount,
    };
  }

  public reset(): void {
    this.status = 'DISCONNECTED';
    this.errorsCount = 0;
    this.cacheHitsCount = 0;
    this.cacheMissesCount = 0;
    this.lockAcquisitionSuccessCount = 0;
    this.lockAcquisitionFailureCount = 0;
    this.rateLimitBlocksCount = 0;
  }
}

export const redisMetrics = new RedisMetricsCollector();
