import { getRedisClient, IRedisClient } from './redis.client.js';
import { RedisKeys } from './redis.keys.js';
import { redisMetrics } from './redis.metrics.js';
import { logger } from '../../common/logger.js';
import { config } from '../../config/index.js';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
}

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowSec = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local clearBefore = now - windowSec * 1000

redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
local currentCount = redis.call('ZCARD', key)

if currentCount < limit then
  redis.call('ZADD', key, now, now .. '-' .. ARGV[4])
  redis.call('EXPIRE', key, windowSec)
  return {1, limit - currentCount - 1, windowSec}
else
  return {0, 0, windowSec}
end
`;

export class RedisRateLimiterService {
  constructor(private clientGetter: () => Promise<IRedisClient> = getRedisClient) {}

  /**
   * Evaluates sliding-window rate limit atomically across distributed API instances.
   */
  public async consume(
    identifier: string,
    limit: number = config.RATE_LIMIT_MAX_REQUESTS,
    windowSec: number = config.RATE_LIMIT_WINDOW_SECS
  ): Promise<RateLimitResult> {
    const key = RedisKeys.rateLimit(identifier);
    const now = Date.now();
    const nonce = Math.random().toString(36).substring(2, 8);

    try {
      const client = await this.clientGetter();
      const res = (await client.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        now,
        windowSec,
        limit,
        nonce
      )) as [number, number, number] | null;

      const allowed = res ? res[0] === 1 : true;
      const remaining = res ? Number(res[1]) : limit - 1;
      const retryAfter = res ? Number(res[2]) : windowSec;

      if (!allowed) {
        redisMetrics.recordRateLimitBlock();
      }

      return {
        allowed,
        limit,
        remaining: Math.max(0, remaining),
        retryAfterSeconds: allowed ? 0 : retryAfter,
        resetAt: Math.ceil((now + windowSec * 1000) / 1000),
      };
    } catch (err) {
      logger.warn('Redis rate limiter failed; failing open for operational continuity', {
        identifier,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      // Fallback: Fail open so financial transactions are not blocked by cache failure
      return {
        allowed: true,
        limit,
        remaining: limit,
        retryAfterSeconds: 0,
        resetAt: Math.ceil((now + windowSec * 1000) / 1000),
      };
    }
  }
}

let activeRateLimiterService: RedisRateLimiterService | null = null;

export function getRedisRateLimiterService(): RedisRateLimiterService {
  if (!activeRateLimiterService) {
    activeRateLimiterService = new RedisRateLimiterService();
  }
  return activeRateLimiterService;
}

export function setRedisRateLimiterService(service: RedisRateLimiterService): void {
  activeRateLimiterService = service;
}
