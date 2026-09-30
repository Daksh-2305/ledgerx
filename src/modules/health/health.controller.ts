import { Request, Response } from 'express';
import { checkDatabaseHealth } from '../../db/client.js';
import { checkRedisHealth } from '../../infra/redis/redis.client.js';
import { redisMetrics } from '../../infra/redis/redis.metrics.js';
import { checkKafkaHealth } from '../../infra/kafka/kafka.client.js';
import { kafkaMetrics } from '../../infra/kafka/kafka.metrics.js';
import { webhookMetrics } from '../webhooks/webhook.metrics.js';
import { prometheusRegistry } from '../../common/metrics/prometheus.js';
import { config } from '../../config/index.js';
import { SUPPORTED_CURRENCIES } from '../../common/money.js';

let isShuttingDown = false;

export function setServerShuttingDown(val: boolean): void {
  isShuttingDown = val;
}

export class HealthController {
  /**
   * Process Liveness Probe (Section 5)
   * Answers: "Is the application process alive?"
   */
  public static async getLiveness(_req: Request, res: Response): Promise<void> {
    res.status(200).json({
      status: 'UP',
      service: config.SERVICE_NAME,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }

  /**
   * Readiness Probe (Section 5)
   * Answers: "Can this instance safely receive incoming traffic?"
   */
  public static async getReadiness(req: Request, res: Response): Promise<void> {
    if (isShuttingDown) {
      res.status(503).json({
        status: 'SHUTTING_DOWN',
        service: config.SERVICE_NAME,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const [dbHealth, redisHealth, kafkaHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
      checkKafkaHealth(),
    ]);

    // PostgreSQL is the authoritative financial data source
    const isReady = dbHealth.connected;

    const responseBody = {
      status: isReady ? 'UP' : 'DOWN',
      service: config.SERVICE_NAME,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      dependencies: {
        database: dbHealth.connected ? 'UP' : 'DOWN',
        redis: redisHealth.connected ? 'UP' : 'DEGRADED',
        kafka: kafkaHealth.connected ? 'UP' : 'DEGRADED',
      },
      health: {
        postgres: dbHealth.connected ? 'healthy' : 'unhealthy',
        redis: redisHealth.connected ? 'healthy' : 'degraded',
        kafka: kafkaHealth.connected ? 'healthy' : 'degraded',
      },
      metrics: {
        redis: redisMetrics.getSnapshot(),
        kafka: kafkaMetrics.getSnapshot(),
        webhooks: webhookMetrics.getSnapshot(),
      },
      memory: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        heapTotalBytes: process.memoryUsage().heapTotal,
      },
      meta: {
        correlationId: req.correlationId,
        requestId: req.requestId,
      },
    };

    res.status(isReady ? 200 : 503).json(responseBody);
  }

  /**
   * Detailed Dependency Health (Section 5)
   * Inspects detailed latencies, memory usage, and operational components.
   */
  public static async getDependencies(req: Request, res: Response): Promise<void> {
    const [dbHealth, redisHealth, kafkaHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
      checkKafkaHealth(),
    ]);

    const isHealthy = dbHealth.connected;

    const responseBody = {
      status: isHealthy ? 'HEALTHY' : 'UNHEALTHY',
      service: config.SERVICE_NAME,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        heapTotalBytes: process.memoryUsage().heapTotal,
      },
      dependencies: {
        database: {
          status: dbHealth.connected ? 'UP' : 'DOWN',
          connected: dbHealth.connected,
          latencyMs: dbHealth.latencyMs,
          ...(dbHealth.error && { error: dbHealth.error }),
        },
        redis: {
          status: redisHealth.connected ? 'UP' : 'DOWN',
          connected: redisHealth.connected,
          latencyMs: redisHealth.latencyMs,
          ...(redisHealth.error && { error: redisHealth.error }),
        },
        kafka: {
          status: kafkaHealth.connected ? 'UP' : 'DOWN',
          connected: kafkaHealth.connected,
          latencyMs: kafkaHealth.latencyMs,
          ...(kafkaHealth.error && { error: kafkaHealth.error }),
        },
      },
      health: {
        postgres: dbHealth.connected ? 'healthy' : 'unhealthy',
        redis: redisHealth.connected ? 'healthy' : 'degraded',
        kafka: kafkaHealth.connected ? 'healthy' : 'degraded',
      },
      metrics: {
        redis: redisMetrics.getSnapshot(),
        kafka: kafkaMetrics.getSnapshot(),
        webhooks: webhookMetrics.getSnapshot(),
      },
      meta: {
        correlationId: req.correlationId,
        requestId: req.requestId,
      },
    };

    res.status(isHealthy ? 200 : 503).json(responseBody);
  }

  /**
   * Standard OpenMetrics / Prometheus Exposition Endpoint (Section 8)
   * GET /metrics
   */
  public static async getPrometheusMetrics(_req: Request, res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(prometheusRegistry.getMetricsString());
  }

  public static async getPlatformInfo(req: Request, res: Response): Promise<void> {
    res.status(200).json({
      platform: 'LedgerX',
      tagline: 'High-Integrity Payment Infrastructure & Financial Reconciliation Platform',
      version: '0.1.0',
      milestone: 'Milestone 12 — Production Hardening, CI/CD & Observability',
      environment: config.NODE_ENV,
      supportedCurrencies: Object.keys(SUPPORTED_CURRENCIES),
      services: [
        { name: 'api-gateway', port: 3000, status: 'ACTIVE' },
        { name: 'payment-service', port: 3001, status: 'ACTIVE' },
        { name: 'ledger-service', port: 3002, status: 'ACTIVE' },
        { name: 'risk-engine', port: 3003, status: 'ACTIVE' },
        { name: 'webhook-processor', port: 3004, status: 'ACTIVE' },
        { name: 'reconciliation-service', port: 3005, status: 'ACTIVE' },
        { name: 'settlement-service', port: 3006, status: 'ACTIVE' },
      ],
      meta: {
        correlationId: req.correlationId,
        requestId: req.requestId,
      },
    });
  }
}

