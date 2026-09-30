import crypto from 'node:crypto';
import { IRiskRule, RiskRuleContext, RiskRuleResult } from './risk.types.js';
import { config } from '../../config/index.js';
import { IRedisClient, getRedisClient } from '../../infra/redis/redis.client.js';
import { logger } from '../../common/logger.js';

/**
 * Sliding window counter using Redis sorted sets.
 */
async function recordAndGetCount(
  redis: IRedisClient,
  key: string,
  windowSecs: number,
  nowMs = Date.now()
): Promise<{ count: number; degraded: boolean }> {
  try {
    if (!redis.isAvailable()) {
      return { count: 0, degraded: true };
    }
    const cutoff = nowMs - windowSecs * 1000;
    await redis.zremrangebyscore(key, 0, cutoff);
    await redis.zadd(key, nowMs, `${nowMs}-${crypto.randomUUID()}`);
    await redis.expire(key, windowSecs + 10);
    const count = await redis.zcard(key);
    return { count, degraded: false };
  } catch (err) {
    logger.warn(`Redis risk velocity operation failed on key ${key}`, {
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return { count: 0, degraded: true };
  }
}

async function getCountOnly(
  redis: IRedisClient,
  key: string,
  windowSecs: number,
  nowMs = Date.now()
): Promise<{ count: number; degraded: boolean }> {
  try {
    if (!redis.isAvailable()) {
      return { count: 0, degraded: true };
    }
    const cutoff = nowMs - windowSecs * 1000;
    await redis.zremrangebyscore(key, 0, cutoff);
    const count = await redis.zcard(key);
    return { count, degraded: false };
  } catch (err) {
    logger.warn(`Redis risk read operation failed on key ${key}`, {
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return { count: 0, degraded: true };
  }
}

/**
 * Record a payment failure signal in Redis for a customer.
 */
export async function recordPaymentFailureSignal(
  clientOrId: IRedisClient | string,
  idOrClient?: string | IRedisClient,
  _timeOrWindow?: Date | number,
  windowSecs = config.RISK_FAILURE_VELOCITY_WINDOW_SECS
): Promise<void> {
  let redis: IRedisClient;
  let customerId: string;
  if (typeof clientOrId === 'string') {
    customerId = clientOrId;
    redis = (idOrClient as IRedisClient) ?? (await getRedisClient());
  } else {
    redis = clientOrId;
    customerId = idOrClient as string;
  }
  const key = `risk:failures:customer:${customerId}`;
  const win = typeof _timeOrWindow === 'number' ? _timeOrWindow : windowSecs;
  await recordAndGetCount(redis, key, win);
}

/**
 * Record a refund signal in Redis for a merchant.
 */
export async function recordRefundSignal(
  clientOrId: IRedisClient | string,
  idOrClient?: string | IRedisClient,
  _timeOrWindow?: Date | number,
  windowSecs = config.RISK_REFUND_VELOCITY_WINDOW_SECS
): Promise<void> {
  let redis: IRedisClient;
  let merchantId: string;
  if (typeof clientOrId === 'string') {
    merchantId = clientOrId;
    redis = (idOrClient as IRedisClient) ?? (await getRedisClient());
  } else {
    redis = clientOrId;
    merchantId = idOrClient as string;
  }
  const key = `risk:refunds:merchant:${merchantId}`;
  const win = typeof _timeOrWindow === 'number' ? _timeOrWindow : windowSecs;
  await recordAndGetCount(redis, key, win);
}

/**
 * Rule 1 — High Payment Amount
 */
export class HighPaymentAmountRule implements IRiskRule {
  public readonly id = 'HIGH_PAYMENT_AMOUNT';
  public readonly name = 'High Payment Amount';
  public readonly description = 'Detects payments exceeding configured single-payment threshold';

  constructor(
    private thresholdMinor = config.RISK_HIGH_PAYMENT_THRESHOLD_MINOR,
    private scoreValue = config.RISK_SCORE_HIGH_PAYMENT
  ) {}

  public async evaluate(context: RiskRuleContext): Promise<RiskRuleResult> {
    const amountMinor = typeof context.amountMinor === 'bigint' ? context.amountMinor : BigInt(context.amountMinor);
    const thresholdBigInt = BigInt(this.thresholdMinor);

    if (amountMinor >= thresholdBigInt) {
      return {
        rule_id: this.id,
        ruleId: this.id,
        rule_name: this.name,
        triggered: true,
        score: this.scoreValue,
        reason: `Payment amount (${(Number(amountMinor) / 100).toFixed(2)} ${context.currency}) exceeds threshold (${(this.thresholdMinor / 100).toFixed(2)} ${context.currency})`,
        metadata: {
          amountMinor: Number(amountMinor),
          thresholdMinor: this.thresholdMinor,
        },
      };
    }

    return {
      rule_id: this.id,
      ruleId: this.id,
      rule_name: this.name,
      triggered: false,
      score: 0,
      reason: null,
      metadata: {
        amountMinor: Number(amountMinor),
        thresholdMinor: this.thresholdMinor,
      },
    };
  }
}

/**
 * Rule 2 — Payment Velocity (Merchant frequency)
 */
export class PaymentVelocityRule implements IRiskRule {
  public readonly id = 'HIGH_PAYMENT_VELOCITY';
  public readonly name = 'High Payment Velocity';
  public readonly description = 'Detects excessive transaction frequency for a merchant within a short window';

  constructor(
    private maxCount = config.RISK_PAYMENT_VELOCITY_MAX_COUNT,
    private windowSecs = config.RISK_PAYMENT_VELOCITY_WINDOW_SECS,
    private scoreValue = config.RISK_SCORE_PAYMENT_VELOCITY,
    private redisGetter: () => Promise<IRedisClient> = getRedisClient
  ) {}

  public async evaluate(context: RiskRuleContext): Promise<RiskRuleResult> {
    const redis = context.redis ?? (await this.redisGetter());
    const key = `risk:velocity:merchant:${context.merchantId}`;
    const { count, degraded } = await recordAndGetCount(redis, key, this.windowSecs);

    if (degraded) {
      return {
        rule_id: this.id,
        ruleId: this.id,
        rule_name: this.name,
        triggered: false,
        score: 0,
        reason: null,
        metadata: { degraded: true },
      };
    }

    if (count > this.maxCount) {
      return {
        rule_id: this.id,
        ruleId: this.id,
        rule_name: this.name,
        triggered: true,
        score: this.scoreValue,
        reason: `Payment velocity exceeded: ${count} transactions within ${this.windowSecs}s (threshold: ${this.maxCount})`,
        metadata: { count, maxCount: this.maxCount, windowSecs: this.windowSecs },
      };
    }

    return {
      rule_id: this.id,
      ruleId: this.id,
      rule_name: this.name,
      triggered: false,
      score: 0,
      reason: null,
      metadata: { count, maxCount: this.maxCount, windowSecs: this.windowSecs },
    };
  }
}

/**
 * Rule 3 — Repeated Payment Failures
 */
export class RepeatedPaymentFailuresRule implements IRiskRule {
  public readonly id = 'REPEATED_PAYMENT_FAILURES';
  public readonly name = 'Repeated Payment Failures';
  public readonly description = 'Detects repeated failed payments from the same customer within a sliding window';

  constructor(
    private maxCount = config.RISK_FAILURE_VELOCITY_MAX_COUNT,
    private windowSecs = config.RISK_FAILURE_VELOCITY_WINDOW_SECS,
    private scoreValue = config.RISK_SCORE_REPEATED_FAILURES,
    private redisGetter: () => Promise<IRedisClient> = getRedisClient
  ) {}

  public async evaluate(context: RiskRuleContext): Promise<RiskRuleResult> {
    const redis = context.redis ?? (await this.redisGetter());
    const key = `risk:failures:customer:${context.customerId}`;
    const { count, degraded } = await getCountOnly(redis, key, this.windowSecs);

    if (degraded) {
      return {
        rule_id: this.id,
        ruleId: this.id,
        rule_name: this.name,
        triggered: false,
        score: 0,
        reason: null,
        metadata: { degraded: true },
      };
    }

    if (count >= this.maxCount) {
      return {
        rule_id: this.id,
        ruleId: this.id,
        rule_name: this.name,
        triggered: true,
        score: this.scoreValue,
        reason: `Repeated payment failures detected: ${count} failed attempts within ${this.windowSecs}s (threshold: ${this.maxCount})`,
        metadata: { count, maxCount: this.maxCount, windowSecs: this.windowSecs },
      };
    }

    return {
      rule_id: this.id,
      ruleId: this.id,
      rule_name: this.name,
      triggered: false,
      score: 0,
      reason: null,
      metadata: { count, maxCount: this.maxCount, windowSecs: this.windowSecs },
    };
  }
}

/**
 * Rule 4 — Rapid Repeated Payments (Burst detection)
 */
export class RapidTransactionBurstRule implements IRiskRule {
  public readonly id = 'RAPID_TRANSACTION_BURST';
  public readonly name = 'Rapid Transaction Burst';
  public readonly description = 'Detects multiple rapid payments from the same customer within seconds';

  constructor(
    private maxCount = config.RISK_BURST_MAX_COUNT,
    private windowSecs = config.RISK_BURST_WINDOW_SECS,
    private scoreValue = config.RISK_SCORE_RAPID_BURST,
    private redisGetter: () => Promise<IRedisClient> = getRedisClient
  ) {}

  public async evaluate(context: RiskRuleContext): Promise<RiskRuleResult> {
    const redis = context.redis ?? (await this.redisGetter());
    const key = `risk:burst:customer:${context.customerId}`;
    const { count, degraded } = await recordAndGetCount(redis, key, this.windowSecs);

    if (degraded) {
      return {
        rule_id: this.id,
        ruleId: this.id,
        rule_name: this.name,
        triggered: false,
        score: 0,
        reason: null,
        metadata: { degraded: true },
      };
    }

    if (count >= this.maxCount) {
      return {
        rule_id: this.id,
        ruleId: this.id,
        rule_name: this.name,
        triggered: true,
        score: this.scoreValue,
        reason: `Rapid transaction burst detected: ${count} transactions within ${this.windowSecs}s from customer`,
        metadata: { count, maxCount: this.maxCount, windowSecs: this.windowSecs },
      };
    }

    return {
      rule_id: this.id,
      ruleId: this.id,
      rule_name: this.name,
      triggered: false,
      score: 0,
      reason: null,
      metadata: { count, maxCount: this.maxCount, windowSecs: this.windowSecs },
    };
  }
}

/**
 * Rule 5 — High Refund Velocity
 */
export class HighRefundVelocityRule implements IRiskRule {
  public readonly id = 'HIGH_REFUND_VELOCITY';
  public readonly name = 'High Refund Velocity';
  public readonly description = 'Detects excessive refund activity for a merchant within a sliding window';

  constructor(
    private maxCount = config.RISK_REFUND_VELOCITY_MAX_COUNT,
    private windowSecs = config.RISK_REFUND_VELOCITY_WINDOW_SECS,
    private scoreValue = config.RISK_SCORE_REFUND_VELOCITY,
    private redisGetter: () => Promise<IRedisClient> = getRedisClient
  ) {}

  public async evaluate(context: RiskRuleContext): Promise<RiskRuleResult> {
    const redis = context.redis ?? (await this.redisGetter());
    const key = `risk:refunds:merchant:${context.merchantId}`;
    const { count, degraded } = await getCountOnly(redis, key, this.windowSecs);

    if (degraded) {
      return {
        rule_id: this.id,
        ruleId: this.id,
        rule_name: this.name,
        triggered: false,
        score: 0,
        reason: null,
        metadata: { degraded: true },
      };
    }

    if (count >= this.maxCount) {
      return {
        rule_id: this.id,
        ruleId: this.id,
        rule_name: this.name,
        triggered: true,
        score: this.scoreValue,
        reason: `High refund velocity detected: ${count} refunds within ${this.windowSecs}s for merchant`,
        metadata: { count, maxCount: this.maxCount, windowSecs: this.windowSecs },
      };
    }

    return {
      rule_id: this.id,
      ruleId: this.id,
      rule_name: this.name,
      triggered: false,
      score: 0,
      reason: null,
      metadata: { count, maxCount: this.maxCount, windowSecs: this.windowSecs },
    };
  }
}

/**
 * Default rule factory instantiating the full set of 5 modular risk rules.
 */
export function createDefaultRiskRules(redisGetter?: () => Promise<IRedisClient>): IRiskRule[] {
  return [
    new HighPaymentAmountRule(),
    new PaymentVelocityRule(undefined, undefined, undefined, redisGetter),
    new RepeatedPaymentFailuresRule(undefined, undefined, undefined, redisGetter),
    new RapidTransactionBurstRule(undefined, undefined, undefined, redisGetter),
    new HighRefundVelocityRule(undefined, undefined, undefined, redisGetter),
  ];
}
