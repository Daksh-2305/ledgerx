import crypto from 'node:crypto';
import {
  IdempotencyRecordEntity,
  computeRequestHash,
} from './idempotency.types.js';
import {
  IdempotencyKeyReusedError,
  IdempotencyConflictError,
} from '../errors.js';
import { getPrismaClient, checkDatabaseHealth } from '../../db/client.js';
import { logger } from '../logger.js';
import { getRedisClient, IRedisClient } from '../../infra/redis/redis.client.js';
import { RedisKeys } from '../../infra/redis/redis.keys.js';

export interface AcquireResult {
  isNew: boolean;
  responseStatus?: number;
  responseBody?: unknown;
}

export interface IIdempotencyRepository {
  acquire(
    key: string,
    merchantId: string | null,
    method: string,
    path: string,
    hash: string,
    expiresAt: Date
  ): Promise<AcquireResult>;

  complete(key: string, statusCode: number, responseBody: unknown): Promise<void>;
  fail(key: string): Promise<void>;
  clear(): void;
}

/**
 * Thread-safe In-Memory Idempotency Repository
 */
export class InMemoryIdempotencyRepository implements IIdempotencyRepository {
  private records = new Map<string, IdempotencyRecordEntity>();
  private keyLocks = new Map<string, Promise<void>>();

  private async acquireKeyLock(key: string): Promise<() => void> {
    while (this.keyLocks.has(key)) {
      await this.keyLocks.get(key);
    }
    let release!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.keyLocks.set(key, lockPromise);

    return () => {
      this.keyLocks.delete(key);
      release();
    };
  }

  public async acquire(
    key: string,
    merchantId: string | null,
    method: string,
    path: string,
    hash: string,
    expiresAt: Date
  ): Promise<AcquireResult> {
    const release = await this.acquireKeyLock(key);
    try {
      const existing = this.records.get(key);
      const now = new Date();

      if (!existing || existing.expiresAt < now) {
        // Create new in-progress record
        const record: IdempotencyRecordEntity = {
          id: crypto.randomUUID(),
          key,
          merchantId,
          requestMethod: method,
          requestPath: path,
          requestHash: hash,
          status: 'IN_PROGRESS',
          createdAt: now,
          expiresAt,
        };
        this.records.set(key, record);
        return { isNew: true };
      }

      // 1. Same key + different request payload verification
      if (existing.requestHash !== hash) {
        throw new IdempotencyKeyReusedError(
          `Idempotency key '${key}' has already been used for a different request payload or endpoint.`
        );
      }

      // 2. If existing request is still in-progress, reject concurrent duplicate
      if (existing.status === 'IN_PROGRESS') {
        throw new IdempotencyConflictError(
          `Concurrent request with idempotency key '${key}' is currently in progress.`
        );
      }

      // 3. If previous request failed, allow client retry
      if (existing.status === 'FAILED') {
        existing.status = 'IN_PROGRESS';
        existing.requestHash = hash;
        existing.expiresAt = expiresAt;
        this.records.set(key, existing);
        return { isNew: true };
      }

      // 4. Return cached completed response
      return {
        isNew: false,
        responseStatus: existing.responseStatus ?? 200,
        responseBody: existing.responseBody,
      };
    } finally {
      release();
    }
  }

  public async complete(key: string, statusCode: number, responseBody: unknown): Promise<void> {
    const record = this.records.get(key);
    if (record) {
      record.status = 'COMPLETED';
      record.responseStatus = statusCode;
      record.responseBody = responseBody;
      this.records.set(key, record);
    }
  }

  public async fail(key: string): Promise<void> {
    const record = this.records.get(key);
    if (record) {
      record.status = 'FAILED';
      this.records.set(key, record);
    }
  }

  public clear(): void {
    this.records.clear();
  }
}

/**
 * PostgreSQL Prisma-backed Idempotency Repository
 */
export class PrismaIdempotencyRepository implements IIdempotencyRepository {
  private prisma = getPrismaClient();

  public async acquire(
    key: string,
    merchantId: string | null,
    method: string,
    path: string,
    hash: string,
    expiresAt: Date
  ): Promise<AcquireResult> {
    return await this.prisma.$transaction(async (tx) => {
      const existing = await tx.idempotencyRecord.findUnique({
        where: { key },
      });

      const now = new Date();

      if (!existing || existing.expiresAt < now) {
        if (existing) {
          await tx.idempotencyRecord.delete({ where: { key } });
        }

        await tx.idempotencyRecord.create({
          data: {
            key,
            merchantId,
            requestMethod: method,
            requestPath: path,
            requestHash: hash,
            status: 'IN_PROGRESS',
            expiresAt,
          },
        });
        return { isNew: true };
      }

      if (existing.requestHash !== hash) {
        throw new IdempotencyKeyReusedError(
          `Idempotency key '${key}' has already been used for a different request payload or endpoint.`
        );
      }

      if (existing.status === 'IN_PROGRESS') {
        throw new IdempotencyConflictError(
          `Concurrent request with idempotency key '${key}' is currently in progress.`
        );
      }

      if (existing.status === 'FAILED') {
        await tx.idempotencyRecord.update({
          where: { key },
          data: { status: 'IN_PROGRESS', requestHash: hash, expiresAt },
        });
        return { isNew: true };
      }

      return {
        isNew: false,
        responseStatus: existing.responseStatus ?? 200,
        responseBody: existing.responseBody,
      };
    });
  }

  public async complete(key: string, statusCode: number, responseBody: unknown): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.update({
        where: { key },
        data: {
          status: 'COMPLETED',
          responseStatus: statusCode,
          responseBody: (responseBody || {}) as object,
        },
      });
    } catch (_) {}
  }

  public async fail(key: string): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.update({
        where: { key },
        data: { status: 'FAILED' },
      });
    } catch (_) {}
  }

  public clear(): void {}
}

export class IdempotencyService {
  private keyToMerchant = new Map<string, string | null>();
  private keyToHash = new Map<string, string>();

  constructor(
    private readonly repository: IIdempotencyRepository,
    private readonly redisClientGetter: () => Promise<IRedisClient> = getRedisClient
  ) {}

  public async processOrLookup(
    key: string,
    merchantId: string | null,
    method: string,
    path: string,
    body: unknown,
    ttlSeconds: number = 86400 // 24 hours
  ): Promise<AcquireResult> {
    this.keyToMerchant.set(key, merchantId);
    const hash = computeRequestHash(method, path, body);
    this.keyToHash.set(key, hash);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    // Fast-path coordination check via Redis (non-blocking, fallback-safe)
    try {
      const redisClient = await this.redisClientGetter();
      const redisKey = RedisKeys.idempotency(merchantId, key);
      const cached = await redisClient.get(redisKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.hash && parsed.hash !== hash) {
          throw new IdempotencyKeyReusedError(
            `Idempotency key '${key}' has already been used for a different request payload or endpoint.`
          );
        }
        if (parsed.status === 'IN_PROGRESS') {
          throw new IdempotencyConflictError(
            `Concurrent request with idempotency key '${key}' is currently in progress.`
          );
        }
        if (parsed.status === 'COMPLETED') {
          return {
            isNew: false,
            responseStatus: parsed.responseStatus ?? 200,
            responseBody: parsed.responseBody,
          };
        }
      }
    } catch (err) {
      if (err instanceof IdempotencyKeyReusedError || err instanceof IdempotencyConflictError) {
        throw err;
      }
      // Redis offline/error: gracefully proceed to authoritative PostgreSQL check
    }

    // Authoritative execution via PostgreSQL (or authoritative repository)
    const result = await this.repository.acquire(key, merchantId, method, path, hash, expiresAt);

    // Synchronize fast-path in Redis
    try {
      const redisClient = await this.redisClientGetter();
      const redisKey = RedisKeys.idempotency(merchantId, key);
      if (result.isNew) {
        await redisClient.set(redisKey, JSON.stringify({ status: 'IN_PROGRESS', hash }), 'EX', 120);
      } else {
        await redisClient.set(
          redisKey,
          JSON.stringify({
            status: 'COMPLETED',
            hash,
            responseStatus: result.responseStatus,
            responseBody: result.responseBody,
          }),
          'EX',
          ttlSeconds
        );
      }
    } catch (_) {
      // Redis errors never fail authoritative financial operations
    }

    return result;
  }

  public async markCompleted(
    key: string,
    statusCode: number,
    responseBody: unknown,
    merchantId?: string | null
  ): Promise<void> {
    const mId = merchantId !== undefined ? merchantId : this.keyToMerchant.get(key) ?? null;
    const hash = this.keyToHash.get(key);
    this.keyToMerchant.delete(key);
    this.keyToHash.delete(key);

    await this.repository.complete(key, statusCode, responseBody);

    try {
      const redisClient = await this.redisClientGetter();
      const redisKey = RedisKeys.idempotency(mId, key);
      await redisClient.set(
        redisKey,
        JSON.stringify({
          status: 'COMPLETED',
          hash,
          responseStatus: statusCode,
          responseBody,
        }),
        'EX',
        86400
      );
    } catch (_) {}
  }

  public async markFailed(key: string, merchantId?: string | null): Promise<void> {
    const mId = merchantId !== undefined ? merchantId : this.keyToMerchant.get(key) ?? null;
    this.keyToMerchant.delete(key);
    this.keyToHash.delete(key);

    await this.repository.fail(key);

    try {
      const redisClient = await this.redisClientGetter();
      const redisKey = RedisKeys.idempotency(mId, key);
      await redisClient.del(redisKey);
    } catch (_) {}
  }
}

let activeIdempotencyService: IdempotencyService | null = null;

export async function getIdempotencyService(): Promise<IdempotencyService> {
  if (!activeIdempotencyService) {
    if (process.env.NODE_ENV === 'test') {
      activeIdempotencyService = new IdempotencyService(new InMemoryIdempotencyRepository());
      return activeIdempotencyService;
    }
    const dbHealth = await checkDatabaseHealth();
    let repo: IIdempotencyRepository;
    if (dbHealth.connected) {
      logger.info('Using PrismaIdempotencyRepository (PostgreSQL connected)');
      repo = new PrismaIdempotencyRepository();
    } else {
      repo = new InMemoryIdempotencyRepository();
    }
    activeIdempotencyService = new IdempotencyService(repo);
  }
  return activeIdempotencyService;
}

export function setIdempotencyService(service: IdempotencyService): void {
  activeIdempotencyService = service;
}

export function resetIdempotencyService(): void {
  activeIdempotencyService = null;
}
