import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  SERVICE_NAME: z.string().default('ledgerx-core'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // Database
  DATABASE_URL: z
    .string()
    .default('postgresql://ledgerx_user:ledgerx_secret@localhost:5432/ledgerx_db?schema=public'),

  // Redis Configuration (Milestone 5)
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().default(3000),
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
  RATE_LIMIT_WINDOW_SECS: z.coerce.number().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
  CACHE_TTL_PAYMENT_SECS: z.coerce.number().default(300),
  CACHE_TTL_ACCOUNT_SECS: z.coerce.number().default(60),
  DISTRIBUTED_LOCK_TTL_MS: z.coerce.number().default(5000),

  // Kafka & Outbox (Milestone 6)
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('ledgerx'),
  KAFKA_GROUP_ID: z.string().default('ledgerx-consumer-group'),
  KAFKA_CONNECT_TIMEOUT_MS: z.coerce.number().default(5000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().default(50),
  OUTBOX_MAX_RETRIES: z.coerce.number().default(5),

  // Webhooks & DLQ (Milestone 7)
  WEBHOOK_SECRET: z.string().min(16).default('whsec_mockpay_development_secret_32chars'),
  WEBHOOK_MAX_RETRIES: z.coerce.number().default(5),
  WEBHOOK_RETRY_BASE_DELAY_MS: z.coerce.number().default(1000),
  WEBHOOK_DLQ_TOPIC: z.string().default('ledgerx.webhook.dlq'),
  WEBHOOK_CONSUMER_GROUP: z.string().default('ledgerx-webhook-processor'),
  ADMIN_API_KEY: z.string().min(16).default('ledgerx_admin_secret_key_change_in_production'),

  // Risk Engine Configuration (Milestone 8)
  RISK_CONSUMER_GROUP: z.string().default('ledgerx-risk-engine'),
  RISK_HIGH_PAYMENT_THRESHOLD_MINOR: z.coerce.number().default(500000), // ₹5,000.00 / 500,000 minor units
  RISK_PAYMENT_VELOCITY_MAX_COUNT: z.coerce.number().default(10),
  RISK_PAYMENT_VELOCITY_WINDOW_SECS: z.coerce.number().default(60),
  RISK_FAILURE_VELOCITY_MAX_COUNT: z.coerce.number().default(5),
  RISK_FAILURE_VELOCITY_WINDOW_SECS: z.coerce.number().default(300),
  RISK_BURST_MAX_COUNT: z.coerce.number().default(3),
  RISK_BURST_WINDOW_SECS: z.coerce.number().default(10),
  RISK_REFUND_VELOCITY_MAX_COUNT: z.coerce.number().default(3),
  RISK_REFUND_VELOCITY_WINDOW_SECS: z.coerce.number().default(600),
  RISK_SCORE_HIGH_PAYMENT: z.coerce.number().default(35),
  RISK_SCORE_PAYMENT_VELOCITY: z.coerce.number().default(25),
  RISK_SCORE_REPEATED_FAILURES: z.coerce.number().default(20),
  RISK_SCORE_RAPID_BURST: z.coerce.number().default(15),
  RISK_SCORE_REFUND_VELOCITY: z.coerce.number().default(10),
  RISK_LEVEL_LOW_MAX: z.coerce.number().default(24),
  RISK_LEVEL_MEDIUM_MAX: z.coerce.number().default(49),
  RISK_LEVEL_HIGH_MAX: z.coerce.number().default(74),

  // Reconciliation Configuration (Milestone 9)
  RECONCILIATION_CONSUMER_GROUP: z.string().default('ledgerx-reconciliation'),
  RECONCILIATION_DEFAULT_PROVIDER: z.string().default('mockpay'),
  RECONCILIATION_BATCH_SIZE: z.coerce.number().default(500),

  // Settlement Configuration (Milestone 10)
  SETTLEMENT_CONSUMER_GROUP: z.string().default('ledgerx-settlement'),
  SETTLEMENT_DEFAULT_FEE_BPS: z.coerce.number().default(200), // 200 bps = 2.0%
  SETTLEMENT_REQUIRE_RECONCILIATION: z.coerce.boolean().default(true),

  // Security & Hardening (Milestone 12)
  CORS_ORIGIN: z.string().default('*'),
  JWT_SECRET: z.string().min(16).default('development_jwt_secret_change_in_production_min32chars'),
  BODY_LIMIT: z.string().default('1mb'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().default(10000),

  // Database Connection Pool
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().default(5000),

  // Observability
  METRICS_ENABLED: z.coerce.boolean().default(true),
  TRACING_ENABLED: z.coerce.boolean().default(true),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment variables:', JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const config = parsed.data;
export type Config = z.infer<typeof envSchema>;

// Validate production-grade invariants
if (config.NODE_ENV === 'production') {
  const insecureDefaults = [
    'whsec_mockpay_development_secret_32chars',
    'ledgerx_admin_secret_key_change_in_production',
    'development_jwt_secret_change_in_production_min32chars',
  ];

  if (insecureDefaults.includes(config.WEBHOOK_SECRET)) {
    throw new Error('Production security violation: WEBHOOK_SECRET must not use development default in production environment');
  }
  if (insecureDefaults.includes(config.ADMIN_API_KEY)) {
    throw new Error('Production security violation: ADMIN_API_KEY must not use development default in production environment');
  }
  if (insecureDefaults.includes(config.JWT_SECRET)) {
    throw new Error('Production security violation: JWT_SECRET must not use development default in production environment');
  }
}

/**
 * Returns a sanitized copy of configuration safe for logging without exposing credentials.
 */
export function getSanitizedConfig(): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...config };
  const sensitiveKeys = [
    'DATABASE_URL',
    'REDIS_PASSWORD',
    'WEBHOOK_SECRET',
    'ADMIN_API_KEY',
    'JWT_SECRET',
  ];

  for (const key of sensitiveKeys) {
    if (key in sanitized && sanitized[key]) {
      sanitized[key] = '[REDACTED]';
    }
  }

  return sanitized;
}
