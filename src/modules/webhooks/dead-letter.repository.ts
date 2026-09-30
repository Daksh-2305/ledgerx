import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import { getPrismaClient } from '../../db/client.js';
import { DeadLetterEventEntity, DeadLetterFilter, DeadLetterStatus } from './webhook.types.js';

export interface IDeadLetterRepository {
  save(record: Partial<DeadLetterEventEntity>): Promise<DeadLetterEventEntity>;
  findById(id: string): Promise<DeadLetterEventEntity | null>;
  findByEventId(eventId: string): Promise<DeadLetterEventEntity | null>;
  updateStatus(
    id: string,
    status: DeadLetterStatus,
    metadata?: {
      resolvedBy?: string | null;
      resolutionNotes?: string | null;
    }
  ): Promise<DeadLetterEventEntity>;
  findAll(filter?: DeadLetterFilter): Promise<{ events: DeadLetterEventEntity[]; total: number }>;
  clear?(): Promise<void>;
}

export class PrismaDeadLetterRepository implements IDeadLetterRepository {
  constructor(private client: PrismaClient = getPrismaClient()) {}

  public async save(record: Partial<DeadLetterEventEntity>): Promise<DeadLetterEventEntity> {
    const raw = await this.client.deadLetterEvent.create({
      data: {
        id: record.id ?? crypto.randomUUID(),
        eventId: record.eventId!,
        source: record.source ?? 'webhook-consumer',
        eventType: record.eventType!,
        payload: (record.payload ?? {}) as any,
        reason: record.reason!,
        attempts: record.attempts ?? 0,
        status: (record.status as any) ?? 'PENDING',
        createdAt: record.createdAt ?? new Date(),
        resolvedAt: record.resolvedAt ?? null,
        resolvedBy: record.resolvedBy ?? null,
        resolutionNotes: record.resolutionNotes ?? null,
      },
    });

    return this.toEntity(raw);
  }

  public async findById(id: string): Promise<DeadLetterEventEntity | null> {
    const raw = await this.client.deadLetterEvent.findUnique({
      where: { id },
    });
    return raw ? this.toEntity(raw) : null;
  }

  public async findByEventId(eventId: string): Promise<DeadLetterEventEntity | null> {
    const raw = await this.client.deadLetterEvent.findFirst({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
    });
    return raw ? this.toEntity(raw) : null;
  }

  public async updateStatus(
    id: string,
    status: DeadLetterStatus,
    metadata?: {
      resolvedBy?: string | null;
      resolutionNotes?: string | null;
    }
  ): Promise<DeadLetterEventEntity> {
    const data: any = {
      status: status as any,
    };
    if (status === 'RESOLVED' || status === 'REPLAYED' || status === 'IGNORED') {
      data.resolvedAt = new Date();
    }
    if (metadata?.resolvedBy !== undefined) {
      data.resolvedBy = metadata.resolvedBy;
    }
    if (metadata?.resolutionNotes !== undefined) {
      data.resolutionNotes = metadata.resolutionNotes;
    }

    const raw = await this.client.deadLetterEvent.update({
      where: { id },
      data,
    });

    return this.toEntity(raw);
  }

  public async findAll(filter?: DeadLetterFilter): Promise<{ events: DeadLetterEventEntity[]; total: number }> {
    const where: any = {};
    if (filter?.status) {
      where.status = filter.status as any;
    }
    if (filter?.eventType) {
      where.eventType = filter.eventType;
    }

    const page = filter?.page && filter.page > 0 ? filter.page : 1;
    const limit = filter?.limit && filter.limit > 0 ? filter.limit : 50;
    const skip = (page - 1) * limit;

    const [total, raw] = await Promise.all([
      this.client.deadLetterEvent.count({ where }),
      this.client.deadLetterEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      events: raw.map((r) => this.toEntity(r)),
      total,
    };
  }

  private toEntity(raw: any): DeadLetterEventEntity {
    return {
      id: raw.id,
      eventId: raw.eventId,
      source: raw.source,
      eventType: raw.eventType,
      payload: (raw.payload as Record<string, unknown>) || {},
      reason: raw.reason,
      attempts: raw.attempts,
      status: raw.status as DeadLetterStatus,
      createdAt: raw.createdAt,
      resolvedAt: raw.resolvedAt,
      resolvedBy: raw.resolvedBy,
      resolutionNotes: raw.resolutionNotes,
    };
  }
}

export class InMemoryDeadLetterRepository implements IDeadLetterRepository {
  private events = new Map<string, DeadLetterEventEntity>();

  public async save(record: Partial<DeadLetterEventEntity>): Promise<DeadLetterEventEntity> {
    const now = new Date();
    const id = record.id ?? crypto.randomUUID();

    const entity: DeadLetterEventEntity = {
      id,
      eventId: record.eventId!,
      source: record.source ?? 'webhook-consumer',
      eventType: record.eventType!,
      payload: record.payload ?? {},
      reason: record.reason!,
      attempts: record.attempts ?? 0,
      status: record.status ?? 'PENDING',
      createdAt: record.createdAt ?? now,
      resolvedAt: record.resolvedAt ?? null,
      resolvedBy: record.resolvedBy ?? null,
      resolutionNotes: record.resolutionNotes ?? null,
    };

    this.events.set(id, entity);
    return { ...entity };
  }

  public async findById(id: string): Promise<DeadLetterEventEntity | null> {
    const item = this.events.get(id);
    return item ? { ...item } : null;
  }

  public async findByEventId(eventId: string): Promise<DeadLetterEventEntity | null> {
    for (const item of this.events.values()) {
      if (item.eventId === eventId) {
        return { ...item };
      }
    }
    return null;
  }

  public async updateStatus(
    id: string,
    status: DeadLetterStatus,
    metadata?: {
      resolvedBy?: string | null;
      resolutionNotes?: string | null;
    }
  ): Promise<DeadLetterEventEntity> {
    const existing = this.events.get(id);
    if (!existing) {
      throw new Error(`Dead letter record not found: ${id}`);
    }

    existing.status = status;
    if (status === 'RESOLVED' || status === 'REPLAYED' || status === 'IGNORED') {
      existing.resolvedAt = new Date();
    }
    if (metadata?.resolvedBy !== undefined) {
      existing.resolvedBy = metadata.resolvedBy;
    }
    if (metadata?.resolutionNotes !== undefined) {
      existing.resolutionNotes = metadata.resolutionNotes;
    }

    return { ...existing };
  }

  public async findAll(filter?: DeadLetterFilter): Promise<{ events: DeadLetterEventEntity[]; total: number }> {
    let list = Array.from(this.events.values());

    if (filter?.status) {
      list = list.filter((e) => e.status === filter.status);
    }
    if (filter?.eventType) {
      list = list.filter((e) => e.eventType === filter.eventType);
    }

    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const page = filter?.page && filter.page > 0 ? filter.page : 1;
    const limit = filter?.limit && filter.limit > 0 ? filter.limit : 50;
    const skip = (page - 1) * limit;

    return {
      events: list.slice(skip, skip + limit).map((e) => ({ ...e })),
      total: list.length,
    };
  }

  public async clear(): Promise<void> {
    this.events.clear();
  }
}
