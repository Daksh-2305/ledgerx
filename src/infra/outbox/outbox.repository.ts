import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/client.js';
import { kafkaMetrics } from '../kafka/kafka.metrics.js';

export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

export interface OutboxEventEntity {
  id: string;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  topic: string;
  partitionKey: string;
  correlationId: string | null;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface CreateOutboxEventData {
  eventId?: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  topic: string;
  partitionKey: string;
  correlationId?: string;
  maxAttempts?: number;
}

export interface IOutboxRepository {
  saveEvent(data: CreateOutboxEventData, tx?: unknown): Promise<OutboxEventEntity>;
  fetchUnpublished(limit?: number): Promise<OutboxEventEntity[]>;
  markPublished(id: string): Promise<void>;
  recordFailure(id: string, error: string, maxAttempts?: number): Promise<void>;
  countPending(): Promise<number>;
  findById(id: string): Promise<OutboxEventEntity | null>;
  clear?(): Promise<void>;
}

export class PrismaOutboxRepository implements IOutboxRepository {
  constructor(private client: PrismaClient = getPrismaClient()) {}

  public async saveEvent(data: CreateOutboxEventData, tx?: unknown): Promise<OutboxEventEntity> {
    const db = (tx as PrismaClient) || this.client;
    const eventId = data.eventId || `evt_${crypto.randomUUID()}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = await (db as any).outboxEvent.create({
      data: {
        eventId,
        eventType: data.eventType,
        aggregateType: data.aggregateType,
        aggregateId: data.aggregateId,
        payload: data.payload,
        topic: data.topic,
        partitionKey: data.partitionKey,
        correlationId: data.correlationId || null,
        status: 'PENDING',
        attempts: 0,
        maxAttempts: data.maxAttempts ?? 5,
      },
    });

    return this.mapToEntity(created);
  }

  public async fetchUnpublished(limit = 50): Promise<OutboxEventEntity[]> {
    // Uses raw SQL with SKIP LOCKED for safe multi-worker concurrency
    const events: Array<{
      id: string;
      event_id: string;
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
      topic: string;
      partition_key: string;
      correlation_id: string | null;
      status: string;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      created_at: Date;
      published_at: Date | null;
    }> = await this.client.$queryRaw`
      SELECT id, event_id, event_type, aggregate_type, aggregate_id, payload, topic, partition_key, correlation_id, status, attempts, max_attempts, last_error, created_at, published_at
      FROM outbox_events
      WHERE status IN ('PENDING', 'FAILED')
        AND attempts < max_attempts
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED;
    `;

    return events.map((e) => ({
      id: e.id,
      eventId: e.event_id,
      eventType: e.event_type,
      aggregateType: e.aggregate_type,
      aggregateId: e.aggregate_id,
      payload: e.payload,
      topic: e.topic,
      partitionKey: e.partition_key,
      correlationId: e.correlation_id,
      status: e.status as OutboxStatus,
      attempts: e.attempts,
      maxAttempts: e.max_attempts,
      lastError: e.last_error,
      createdAt: e.created_at,
      publishedAt: e.published_at,
    }));
  }

  public async markPublished(id: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.client as any).outboxEvent.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
    kafkaMetrics.recordOutboxPublished();
  }

  public async recordFailure(id: string, error: string, maxAttempts = 5): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const current = await (this.client as any).outboxEvent.findUnique({ where: { id } });
    if (!current) return;

    const nextAttempts = current.attempts + 1;
    const finalStatus = nextAttempts >= maxAttempts ? 'FAILED' : 'PENDING';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.client as any).outboxEvent.update({
      where: { id },
      data: {
        attempts: nextAttempts,
        lastError: error,
        status: finalStatus,
      },
    });

    if (finalStatus === 'FAILED') {
      kafkaMetrics.recordOutboxFailed();
    }
  }

  public async countPending(): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await (this.client as any).outboxEvent.count({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        attempts: { lt: 5 },
      },
    });
    kafkaMetrics.setOutboxPending(count);
    return count;
  }

  public async findById(id: string): Promise<OutboxEventEntity | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found = await (this.client as any).outboxEvent.findUnique({ where: { id } });
    return found ? this.mapToEntity(found) : null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapToEntity(data: any): OutboxEventEntity {
    return {
      id: data.id,
      eventId: data.eventId,
      eventType: data.eventType,
      aggregateType: data.aggregateType,
      aggregateId: data.aggregateId,
      payload: data.payload,
      topic: data.topic,
      partitionKey: data.partitionKey,
      correlationId: data.correlationId,
      status: data.status,
      attempts: data.attempts,
      maxAttempts: data.maxAttempts,
      lastError: data.lastError,
      createdAt: data.createdAt,
      publishedAt: data.publishedAt,
    };
  }
}

/**
 * In-Memory Outbox Repository for tests
 */
export class InMemoryOutboxRepository implements IOutboxRepository {
  private events: Map<string, OutboxEventEntity> = new Map();
  private lockedIds: Set<string> = new Set();

  public async saveEvent(data: CreateOutboxEventData): Promise<OutboxEventEntity> {
    const id = crypto.randomUUID();
    const eventId = data.eventId || `evt_${crypto.randomUUID()}`;

    const entity: OutboxEventEntity = {
      id,
      eventId,
      eventType: data.eventType,
      aggregateType: data.aggregateType,
      aggregateId: data.aggregateId,
      payload: data.payload,
      topic: data.topic,
      partitionKey: data.partitionKey,
      correlationId: data.correlationId || null,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: data.maxAttempts ?? 5,
      lastError: null,
      createdAt: new Date(),
      publishedAt: null,
    };

    this.events.set(id, entity);
    this.updatePendingCount();
    return entity;
  }

  public async fetchUnpublished(limit = 50): Promise<OutboxEventEntity[]> {
    const candidates: OutboxEventEntity[] = [];

    for (const entity of this.events.values()) {
      if (
        (entity.status === 'PENDING' || (entity.status === 'FAILED' && entity.attempts < entity.maxAttempts)) &&
        !this.lockedIds.has(entity.id)
      ) {
        this.lockedIds.add(entity.id);
        candidates.push({ ...entity });
        if (candidates.length >= limit) break;
      }
    }

    return candidates;
  }

  public async markPublished(id: string): Promise<void> {
    const entity = this.events.get(id);
    if (entity) {
      entity.status = 'PUBLISHED';
      entity.publishedAt = new Date();
      this.events.set(id, entity);
    }
    this.lockedIds.delete(id);
    this.updatePendingCount();
    kafkaMetrics.recordOutboxPublished();
  }

  public async recordFailure(id: string, error: string, maxAttempts = 5): Promise<void> {
    const entity = this.events.get(id);
    if (entity) {
      entity.attempts += 1;
      entity.lastError = error;
      if (entity.attempts >= maxAttempts) {
        entity.status = 'FAILED';
        kafkaMetrics.recordOutboxFailed();
      } else {
        entity.status = 'PENDING';
      }
      this.events.set(id, entity);
    }
    this.lockedIds.delete(id);
    this.updatePendingCount();
  }

  public async countPending(): Promise<number> {
    return this.updatePendingCount();
  }

  public async findById(id: string): Promise<OutboxEventEntity | null> {
    const found = this.events.get(id);
    return found ? { ...found } : null;
  }

  public async clear(): Promise<void> {
    this.events.clear();
    this.lockedIds.clear();
    this.updatePendingCount();
  }

  public unlockAll(): void {
    this.lockedIds.clear();
  }

  private updatePendingCount(): number {
    let count = 0;
    for (const e of this.events.values()) {
      if (e.status === 'PENDING' && e.attempts < e.maxAttempts) {
        count++;
      }
    }
    kafkaMetrics.setOutboxPending(count);
    return count;
  }
}

let activeOutboxRepo: IOutboxRepository | null = null;

export function getOutboxRepository(): IOutboxRepository {
  if (!activeOutboxRepo) {
    if (process.env.NODE_ENV === 'test') {
      activeOutboxRepo = new InMemoryOutboxRepository();
    } else {
      activeOutboxRepo = new PrismaOutboxRepository();
    }
  }
  return activeOutboxRepo;
}

export function setOutboxRepository(repo: IOutboxRepository): void {
  activeOutboxRepo = repo;
}

export function resetOutboxRepository(): void {
  activeOutboxRepo = null;
}
