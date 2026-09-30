import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import { getPrismaClient } from '../../db/client.js';
import { WebhookEventEntity, WebhookEventStatus, WebhookFilter } from './webhook.types.js';

export interface IWebhookRepository {
  save(event: Partial<WebhookEventEntity>): Promise<WebhookEventEntity>;
  findByProviderAndEventId(provider: string, eventId: string): Promise<WebhookEventEntity | null>;
  findById(id: string): Promise<WebhookEventEntity | null>;
  updateStatus(
    id: string,
    status: WebhookEventStatus,
    updates?: {
      attempts?: number;
      lastError?: string | null;
      processedAt?: Date | null;
      nextRetryAt?: Date | null;
    }
  ): Promise<WebhookEventEntity>;
  findPendingRetries(limit?: number): Promise<WebhookEventEntity[]>;
  findEvents(filter: WebhookFilter): Promise<{ events: WebhookEventEntity[]; total: number }>;
  clear?(): Promise<void>;
}

export class PrismaWebhookRepository implements IWebhookRepository {
  constructor(private client: PrismaClient = getPrismaClient()) {}

  public async save(data: Partial<WebhookEventEntity>): Promise<WebhookEventEntity> {
    const raw = await this.client.webhookEvent.create({
      data: {
        id: data.id ?? crypto.randomUUID(),
        eventId: data.eventId!,
        provider: data.provider ?? 'mockpay',
        eventType: data.eventType!,
        externalReference: data.externalReference ?? null,
        merchantId: data.merchantId ?? null,
        signature: data.signature ?? null,
        payload: (data.payload ?? {}) as any,
        status: (data.status as any) ?? 'RECEIVED',
        attempts: data.attempts ?? 0,
        maxAttempts: data.maxAttempts ?? 5,
        lastError: data.lastError ?? null,
        receivedAt: data.receivedAt ?? new Date(),
        processedAt: data.processedAt ?? null,
        nextRetryAt: data.nextRetryAt ?? null,
      },
    });

    return this.toEntity(raw);
  }

  public async findByProviderAndEventId(provider: string, eventId: string): Promise<WebhookEventEntity | null> {
    const raw = await this.client.webhookEvent.findUnique({
      where: {
        uq_webhook_events_provider_event: {
          provider,
          eventId,
        },
      },
    });
    return raw ? this.toEntity(raw) : null;
  }

  public async findById(id: string): Promise<WebhookEventEntity | null> {
    const raw = await this.client.webhookEvent.findUnique({
      where: { id },
    });
    return raw ? this.toEntity(raw) : null;
  }

  public async updateStatus(
    id: string,
    status: WebhookEventStatus,
    updates?: {
      attempts?: number;
      lastError?: string | null;
      processedAt?: Date | null;
      nextRetryAt?: Date | null;
    }
  ): Promise<WebhookEventEntity> {
    const updateData: any = {
      status: status as any,
      updatedAt: new Date(),
    };

    if (updates?.attempts !== undefined) {
      updateData.attempts = updates.attempts;
    }
    if (updates?.lastError !== undefined) {
      updateData.lastError = updates.lastError;
    }
    if (updates?.processedAt !== undefined) {
      updateData.processedAt = updates.processedAt;
    }
    if (updates?.nextRetryAt !== undefined) {
      updateData.nextRetryAt = updates.nextRetryAt;
    }

    const raw = await this.client.webhookEvent.update({
      where: { id },
      data: updateData,
    });

    return this.toEntity(raw);
  }

  public async findPendingRetries(limit = 50): Promise<WebhookEventEntity[]> {
    const raw = await this.client.webhookEvent.findMany({
      where: {
        status: 'RETRY_PENDING' as any,
        nextRetryAt: {
          lte: new Date(),
        },
      },
      orderBy: {
        nextRetryAt: 'asc',
      },
      take: limit,
    });

    return raw.map((r) => this.toEntity(r));
  }

  public async findEvents(filter: WebhookFilter): Promise<{ events: WebhookEventEntity[]; total: number }> {
    const where: any = {};
    if (filter.provider) {
      where.provider = filter.provider;
    }
    if (filter.eventType) {
      where.eventType = filter.eventType;
    }
    if (filter.status) {
      where.status = filter.status as any;
    }
    if (filter.from || filter.to) {
      where.receivedAt = {};
      if (filter.from) where.receivedAt.gte = filter.from;
      if (filter.to) where.receivedAt.lte = filter.to;
    }

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const skip = (page - 1) * limit;

    const [total, raw] = await Promise.all([
      this.client.webhookEvent.count({ where }),
      this.client.webhookEvent.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      events: raw.map((r) => this.toEntity(r)),
      total,
    };
  }

  private toEntity(raw: any): WebhookEventEntity {
    return {
      id: raw.id,
      eventId: raw.eventId,
      provider: raw.provider,
      eventType: raw.eventType,
      externalReference: raw.externalReference,
      merchantId: raw.merchantId,
      signature: raw.signature,
      payload: (raw.payload as Record<string, unknown>) || {},
      status: raw.status as WebhookEventStatus,
      attempts: raw.attempts,
      maxAttempts: raw.maxAttempts,
      lastError: raw.lastError,
      receivedAt: raw.receivedAt,
      processedAt: raw.processedAt,
      nextRetryAt: raw.nextRetryAt,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }
}

export class InMemoryWebhookRepository implements IWebhookRepository {
  private events = new Map<string, WebhookEventEntity>();

  public async save(data: Partial<WebhookEventEntity>): Promise<WebhookEventEntity> {
    const now = new Date();
    const id = data.id || crypto.randomUUID();
    const provider = data.provider || 'mockpay';
    const eventId = data.eventId!;

    // Enforce unique provider + eventId
    for (const item of this.events.values()) {
      if (item.provider === provider && item.eventId === eventId) {
        throw new Error(`Unique constraint failed on (provider, event_id): (${provider}, ${eventId})`);
      }
    }

    const entity: WebhookEventEntity = {
      id,
      eventId,
      provider,
      eventType: data.eventType!,
      externalReference: data.externalReference ?? null,
      merchantId: data.merchantId ?? null,
      signature: data.signature ?? null,
      payload: data.payload ?? {},
      status: data.status ?? 'RECEIVED',
      attempts: data.attempts ?? 0,
      maxAttempts: data.maxAttempts ?? 5,
      lastError: data.lastError ?? null,
      receivedAt: data.receivedAt ?? now,
      processedAt: data.processedAt ?? null,
      nextRetryAt: data.nextRetryAt ?? null,
      createdAt: data.createdAt ?? now,
      updatedAt: data.updatedAt ?? now,
    };

    this.events.set(id, entity);
    return { ...entity };
  }

  public async findByProviderAndEventId(provider: string, eventId: string): Promise<WebhookEventEntity | null> {
    for (const item of this.events.values()) {
      if (item.provider === provider && item.eventId === eventId) {
        return { ...item };
      }
    }
    return null;
  }

  public async findById(id: string): Promise<WebhookEventEntity | null> {
    const item = this.events.get(id);
    return item ? { ...item } : null;
  }

  public async updateStatus(
    id: string,
    status: WebhookEventStatus,
    updates?: {
      attempts?: number;
      lastError?: string | null;
      processedAt?: Date | null;
      nextRetryAt?: Date | null;
    }
  ): Promise<WebhookEventEntity> {
    const existing = this.events.get(id);
    if (!existing) {
      throw new Error(`Webhook event not found: ${id}`);
    }

    existing.status = status;
    existing.updatedAt = new Date();

    if (updates?.attempts !== undefined) {
      existing.attempts = updates.attempts;
    }
    if (updates?.lastError !== undefined) {
      existing.lastError = updates.lastError;
    }
    if (updates?.processedAt !== undefined) {
      existing.processedAt = updates.processedAt;
    }
    if (updates?.nextRetryAt !== undefined) {
      existing.nextRetryAt = updates.nextRetryAt;
    }

    return { ...existing };
  }

  public async findPendingRetries(limit = 50): Promise<WebhookEventEntity[]> {
    const now = new Date();
    const results: WebhookEventEntity[] = [];

    for (const item of this.events.values()) {
      if (item.status === 'RETRY_PENDING' && item.nextRetryAt && item.nextRetryAt <= now) {
        results.push({ ...item });
      }
    }

    results.sort((a, b) => (a.nextRetryAt?.getTime() ?? 0) - (b.nextRetryAt?.getTime() ?? 0));
    return results.slice(0, limit);
  }

  public async findEvents(filter: WebhookFilter): Promise<{ events: WebhookEventEntity[]; total: number }> {
    let list = Array.from(this.events.values());

    if (filter.provider) {
      list = list.filter((e) => e.provider === filter.provider);
    }
    if (filter.eventType) {
      list = list.filter((e) => e.eventType === filter.eventType);
    }
    if (filter.status) {
      list = list.filter((e) => e.status === filter.status);
    }
    if (filter.from) {
      list = list.filter((e) => e.receivedAt >= filter.from!);
    }
    if (filter.to) {
      list = list.filter((e) => e.receivedAt <= filter.to!);
    }

    list.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
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
