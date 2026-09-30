import crypto from 'node:crypto';
import { getRedisClient, IRedisClient } from './redis.client.js';
import { RedisKeys } from './redis.keys.js';
import { redisMetrics } from './redis.metrics.js';
import { logger } from '../../common/logger.js';
import { config } from '../../config/index.js';

export interface LockHandle {
  resource: string;
  token: string;
  acquired: boolean;
  release: () => Promise<boolean>;
}

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export class RedisLockService {
  constructor(private clientGetter: () => Promise<IRedisClient> = getRedisClient) {}

  /**
   * Acquires a distributed lock using atomic SET resource token NX PX ttlMs
   * Generates a unique cryptographic token for safe ownership tracking.
   */
  public async acquireLock(
    resource: string,
    ttlMs: number = config.DISTRIBUTED_LOCK_TTL_MS
  ): Promise<LockHandle> {
    const lockKey = RedisKeys.paymentLock(resource);
    const token = crypto.randomUUID();

    try {
      const client = await this.clientGetter();
      // Atomic NX PX set
      const result = await client.set(lockKey, token, 'PX', ttlMs, 'NX');

      if (result === 'OK') {
        redisMetrics.recordLockSuccess();
        return {
          resource,
          token,
          acquired: true,
          release: () => this.releaseLock(resource, token),
        };
      }

      redisMetrics.recordLockFailure();
      return {
        resource,
        token,
        acquired: false,
        release: async () => false,
      };
    } catch (err) {
      redisMetrics.recordLockFailure();
      logger.warn('Failed to acquire Redis distributed lock; fallback coordination active', {
        resource,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      // In fallback mode, allow caller to proceed under authoritative PostgreSQL concurrency controls
      return {
        resource,
        token,
        acquired: true, // fallback permit
        release: async () => true,
      };
    }
  }

  /**
   * Releases distributed lock atomically with ownership check via Lua script.
   * Returns true if lock was held by this token and deleted, false otherwise.
   */
  public async releaseLock(resource: string, token: string): Promise<boolean> {
    const lockKey = RedisKeys.paymentLock(resource);
    try {
      const client = await this.clientGetter();
      const res = await client.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
      return res === 1 || res === '1';
    } catch (err) {
      logger.warn('Error releasing Redis distributed lock', {
        resource,
        token,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  }
}

let activeLockService: RedisLockService | null = null;

export function getRedisLockService(): RedisLockService {
  if (!activeLockService) {
    activeLockService = new RedisLockService();
  }
  return activeLockService;
}

export function setRedisLockService(service: RedisLockService): void {
  activeLockService = service;
}
