import { Redis as IORedis } from 'ioredis';
import { config } from '../../config/index.js';
import { logger } from '../../common/logger.js';
import { redisMetrics } from './redis.metrics.js';

export interface IRedisClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode?: string,
    time?: number,
    setMode?: string
  ): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  ping(): Promise<string>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
  zcard(key: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  quit(): Promise<void>;
  disconnect(): void;
  isAvailable(): boolean;
}

/**
 * In-Memory Redis Implementation for deterministic unit/integration tests
 * and fallback operational mode when Redis container is not running.
 */
export class InMemoryRedisClient implements IRedisClient {
  private store = new Map<string, { value: string; expiresAt?: number }>();
  private zsets = new Map<string, Array<{ score: number; member: string }>>();
  private available = true;

  public setAvailable(available: boolean): void {
    this.available = available;
  }

  public isAvailable(): boolean {
    return this.available;
  }

  private cleanKey(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  public async get(key: string): Promise<string | null> {
    if (!this.available) throw new Error('Redis connection unavailable');
    if (!this.cleanKey(key)) return null;
    return this.store.get(key)?.value ?? null;
  }

  public async set(
    key: string,
    value: string,
    expiryMode?: string,
    time?: number,
    setMode?: string
  ): Promise<string | null> {
    if (!this.available) throw new Error('Redis connection unavailable');

    // Handle NX (Not eXists) condition
    if ((setMode === 'NX' || expiryMode === 'NX') && this.cleanKey(key)) {
      return null;
    }

    let expiresAt: number | undefined;
    if (expiryMode === 'EX' && time) {
      expiresAt = Date.now() + time * 1000;
    } else if (expiryMode === 'PX' && time) {
      expiresAt = Date.now() + time;
    }
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  public async del(...keys: string[]): Promise<number> {
    if (!this.available) throw new Error('Redis connection unavailable');
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
      if (this.zsets.delete(k)) count++;
    }
    return count;
  }

  public async keys(pattern: string): Promise<string[]> {
    if (!this.available) throw new Error('Redis connection unavailable');
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    const result: string[] = [];
    for (const [key] of this.store) {
      if (this.cleanKey(key) && regex.test(key)) {
        result.push(key);
      }
    }
    return result;
  }

  public async eval(
    script: string,
    _numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    if (!this.available) throw new Error('Redis connection unavailable');

    // 1. Emulate lock release script:
    // if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end
    if (script.includes('redis.call("get", KEYS[1]) == ARGV[1]')) {
      const key = String(args[0]);
      const token = String(args[1]);
      const current = await this.get(key);
      if (current === token) {
        await this.del(key);
        return 1;
      }
      return 0;
    }

    // 2. Emulate sliding window rate limiter script
    if (script.includes('ZREMRANGEBYSCORE')) {
      const key = String(args[0]);
      const now = Number(args[1]);
      const windowSec = Number(args[2]);
      const limit = Number(args[3]);
      const clearBefore = now - windowSec * 1000;

      await this.zremrangebyscore(key, 0, clearBefore);
      const currentCount = await this.zcard(key);
      if (currentCount < limit) {
        await this.zadd(key, now, `${now}-${Math.random()}`);
        await this.expire(key, windowSec);
        return [1, limit - currentCount - 1, windowSec];
      } else {
        return [0, 0, windowSec];
      }
    }

    return null;
  }

  public async ping(): Promise<string> {
    if (!this.available) throw new Error('Redis connection unavailable');
    return 'PONG';
  }

  public async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<number> {
    if (!this.available) throw new Error('Redis connection unavailable');
    const zset = this.zsets.get(key) || [];
    const minVal = Number(min);
    const maxVal = Number(max);
    const filtered = zset.filter((item) => item.score < minVal || item.score > maxVal);
    const removedCount = zset.length - filtered.length;
    this.zsets.set(key, filtered);
    return removedCount;
  }

  public async zcard(key: string): Promise<number> {
    if (!this.available) throw new Error('Redis connection unavailable');
    const zset = this.zsets.get(key) || [];
    return zset.length;
  }

  public async zadd(key: string, score: number, member: string): Promise<number> {
    if (!this.available) throw new Error('Redis connection unavailable');
    let zset = this.zsets.get(key);
    if (!zset) {
      zset = [];
      this.zsets.set(key, zset);
    }
    zset.push({ score, member });
    return 1;
  }

  public async expire(key: string, seconds: number): Promise<number> {
    if (!this.available) throw new Error('Redis connection unavailable');
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + seconds * 1000;
    }
    return 1;
  }

  public async quit(): Promise<void> {
    this.store.clear();
    this.zsets.clear();
  }

  public disconnect(): void {
    this.store.clear();
    this.zsets.clear();
  }

  public clear(): void {
    this.store.clear();
    this.zsets.clear();
  }
}

/**
 * Adapter wrapping ioredis
 */
export class RealRedisClientAdapter implements IRedisClient {
  private client: IORedis;
  private connected = false;

  constructor(client: IORedis) {
    this.client = client;
    this.client.on('connect', () => {
      this.connected = true;
      redisMetrics.setConnectionStatus('CONNECTED');
    });
    this.client.on('error', (err) => {
      this.connected = false;
      redisMetrics.recordError();
      logger.warn('Redis client error', { error: { message: err.message, name: err.name } });
    });
    this.client.on('close', () => {
      this.connected = false;
      redisMetrics.setConnectionStatus('DISCONNECTED');
    });
  }

  public isAvailable(): boolean {
    return this.connected;
  }

  public async get(key: string): Promise<string | null> {
    return await this.client.get(key);
  }

  public async set(
    key: string,
    value: string,
    expiryMode?: string,
    time?: number,
    setMode?: string
  ): Promise<string | null> {
    if (expiryMode && time && setMode) {
      // @ts-expect-error ioredis overload
      return await this.client.set(key, value, expiryMode, time, setMode);
    }
    if (expiryMode && time) {
      // @ts-expect-error ioredis overload
      return await this.client.set(key, value, expiryMode, time);
    }
    return await this.client.set(key, value);
  }

  public async del(...keys: string[]): Promise<number> {
    return await this.client.del(...keys);
  }

  public async keys(pattern: string): Promise<string[]> {
    return await this.client.keys(pattern);
  }

  public async eval(
    script: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    return await this.client.eval(script, numkeys, ...args);
  }

  public async ping(): Promise<string> {
    return await this.client.ping();
  }

  public async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<number> {
    return await this.client.zremrangebyscore(key, min, max);
  }

  public async zcard(key: string): Promise<number> {
    return await this.client.zcard(key);
  }

  public async zadd(key: string, score: number, member: string): Promise<number> {
    return await this.client.zadd(key, score, member);
  }

  public async expire(key: string, seconds: number): Promise<number> {
    return await this.client.expire(key, seconds);
  }

  public async quit(): Promise<void> {
    await this.client.quit();
  }

  public disconnect(): void {
    this.client.disconnect();
  }
}

let activeRedisClient: IRedisClient | null = null;
let lastHealthCheckTime = 0;
let cachedHealthResult: { connected: boolean; latencyMs?: number; error?: string } = {
  connected: false,
};

export async function checkRedisHealth(): Promise<{
  connected: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const now = Date.now();
  if (now - lastHealthCheckTime < 5000 && lastHealthCheckTime > 0) {
    return cachedHealthResult;
  }

  const client = await getRedisClient();
  const start = Date.now();

  try {
    const probeTimeout = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('Redis health probe timed out after 1000ms')), 1000)
    );
    await Promise.race([client.ping(), probeTimeout]);
    const latencyMs = Date.now() - start;
    cachedHealthResult = { connected: true, latencyMs };
    redisMetrics.setConnectionStatus('CONNECTED');
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    cachedHealthResult = { connected: false, error: errorMsg };
    redisMetrics.setConnectionStatus('FALLBACK');
  }

  lastHealthCheckTime = Date.now();
  return cachedHealthResult;
}

export async function getRedisClient(): Promise<IRedisClient> {
  if (activeRedisClient) {
    return activeRedisClient;
  }

  // Attempt real Redis connection
  try {
    const ioClient = new IORedis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: config.REDIS_PASSWORD || undefined,
      connectTimeout: config.REDIS_CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 2) return null; // do not endlessly retry if Redis isn't running locally
        return Math.min(times * 200, 1000);
      },
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    const connectTimeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Redis connect timeout')), 1000)
    );

    await Promise.race([ioClient.connect(), connectTimeout]);
    await ioClient.ping();

    logger.info('Connected to Redis cluster/standalone instance');
    activeRedisClient = new RealRedisClientAdapter(ioClient);
    redisMetrics.setConnectionStatus('CONNECTED');
    return activeRedisClient;
  } catch (err) {
    logger.warn('Redis instance not reachable; falling back to in-memory Redis infrastructure', {
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    activeRedisClient = new InMemoryRedisClient();
    redisMetrics.setConnectionStatus('FALLBACK');
    return activeRedisClient;
  }
}

export function setRedisClient(client: IRedisClient): void {
  activeRedisClient = client;
}

export function resetRedisClient(): void {
  if (activeRedisClient) {
    activeRedisClient.disconnect();
    activeRedisClient = null;
  }
  lastHealthCheckTime = 0;
  cachedHealthResult = { connected: false };
}
