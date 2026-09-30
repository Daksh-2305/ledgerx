import { getRedisClient, IRedisClient } from './redis.client.js';
import { redisMetrics } from './redis.metrics.js';
import { logger } from '../../common/logger.js';

export class RedisCacheService {
  constructor(private clientGetter: () => Promise<IRedisClient> = getRedisClient) {}

  public async get<T>(key: string): Promise<T | null> {
    try {
      const client = await this.clientGetter();
      const raw = await client.get(key);

      if (!raw) {
        redisMetrics.recordCacheMiss();
        return null;
      }

      redisMetrics.recordCacheHit();
      return JSON.parse(raw) as T;
    } catch (err) {
      redisMetrics.recordCacheMiss();
      logger.warn(`Redis cache get failed for key '${key}'. Falling back to PostgreSQL source of truth.`, {
        key,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  public async set<T>(key: string, value: T, ttlSeconds: number = 300): Promise<void> {
    try {
      const client = await this.clientGetter();
      const raw = JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      await client.set(key, raw, 'EX', ttlSeconds);
    } catch (err) {
      logger.warn(`Redis cache set failed for key '${key}'. PostgreSQL remains authoritative.`, {
        key,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  public async del(key: string): Promise<void> {
    try {
      const client = await this.clientGetter();
      await client.del(key);
    } catch (err) {
      logger.warn(`Redis cache del failed for key '${key}'`, {
        key,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  public async delPattern(pattern: string): Promise<void> {
    try {
      const client = await this.clientGetter();
      const keys = await client.keys(pattern);
      if (keys.length > 0) {
        await client.del(...keys);
      }
    } catch (err) {
      logger.warn(`Redis cache delPattern failed for '${pattern}'`, {
        pattern,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

let activeCacheService: RedisCacheService | null = null;

export function getRedisCacheService(): RedisCacheService {
  if (!activeCacheService) {
    activeCacheService = new RedisCacheService();
  }
  return activeCacheService;
}

export function setRedisCacheService(service: RedisCacheService): void {
  activeCacheService = service;
}
