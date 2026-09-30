import crypto from 'node:crypto';
import { PaymentStatus, PaymentStateMachine, RefundStatus } from './payment-state-machine.js';
import {
  ConflictError,
  NotFoundError,
  RefundAmountExceededError,
  InvalidStateTransitionError,
} from '../../common/errors.js';
import { getPrismaClient } from '../../db/client.js';
import {
  IOutboxRepository,
  getOutboxRepository,
  InMemoryOutboxRepository,
} from '../../infra/outbox/outbox.repository.js';
import { KafkaTopics } from '../../infra/kafka/event-envelope.js';

export interface RefundEntity {
  id: string;
  paymentId: string;
  merchantId: string;
  amountMinor: bigint;
  currency: string;
  status: RefundStatus;
  idempotencyKey?: string | null;
  reason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserEntity {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: 'ADMIN' | 'MERCHANT' | 'USER' | 'AUDITOR';
  createdAt: Date;
  updatedAt: Date;
}

export interface MerchantEntity {
  id: string;
  userId?: string | null;
  businessName: string;
  status: string;
  apiKeyHash?: string | null;
  webhookUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerEntity {
  id: string;
  merchantId: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentEntity {
  id: string;
  merchantId: string;
  customerId: string;
  amountMinor: bigint;
  currency: string;
  status: PaymentStatus;
  idempotencyKey?: string | null;
  capturedAmountMinor: bigint;
  refundedAmountMinor: bigint;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLogEntity {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId?: string | null;
  actorType?: string;
  changes?: Record<string, unknown> | null;
  correlationId?: string | null;
  createdAt: Date;
}

export interface PaymentFilter {
  merchantId?: string;
  status?: PaymentStatus;
  fromDate?: Date;
  toDate?: Date;
  page: number;
  limit: number;
}

export interface CreatePaymentInput {
  merchantId: string;
  customerId: string;
  amountMinor: bigint;
  currency: string;
  description?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  actorId?: string;
  correlationId?: string;
}

export interface IPaymentRepository {
  findMerchantById(id: string): Promise<MerchantEntity | null>;
  findCustomerById(id: string): Promise<CustomerEntity | null>;
  findPaymentById(id: string): Promise<PaymentEntity | null>;
  findPaymentWithDetails(
    id: string
  ): Promise<{ payment: PaymentEntity; merchant: MerchantEntity; customer: CustomerEntity; auditLogs: AuditLogEntity[] } | null>;
  findPayments(filter: PaymentFilter): Promise<{ payments: PaymentEntity[]; total: number }>;
  createPayment(data: CreatePaymentInput): Promise<PaymentEntity>;
  create?(data: CreatePaymentInput): Promise<PaymentEntity>;
  transitionPaymentStatus(
    paymentId: string,
    expectedStatus: PaymentStatus,
    targetStatus: PaymentStatus,
    actorId?: string,
    correlationId?: string
  ): Promise<PaymentEntity>;

  // Refunds
  findRefundById(id: string): Promise<RefundEntity | null>;
  findRefundsByPaymentId(
    paymentId: string,
    page: number,
    limit: number
  ): Promise<{ refunds: RefundEntity[]; total: number }>;
  executeRefund(
    paymentId: string,
    refundAmountMinor: bigint,
    reason?: string,
    idempotencyKey?: string,
    actorId?: string,
    correlationId?: string
  ): Promise<{ refund: RefundEntity; payment: PaymentEntity }>;

  // Management / seed helpers
  saveMerchant(merchant: MerchantEntity): Promise<void>;
  saveCustomer(customer: CustomerEntity): Promise<void>;
}

/**
 * In-Memory Payment Repository with thread-safe / atomic concurrency locking
 * Used for deterministic integration testing and standalone operational mode.
 */
export class InMemoryPaymentRepository implements IPaymentRepository {
  private merchants = new Map<string, MerchantEntity>();
  private customers = new Map<string, CustomerEntity>();
  private payments = new Map<string, PaymentEntity>();
  private refunds = new Map<string, RefundEntity>();
  private auditLogs: AuditLogEntity[] = [];

  constructor(private outboxRepo: IOutboxRepository = getOutboxRepository()) {
    if (this.outboxRepo.constructor.name === 'PrismaOutboxRepository') {
      this.outboxRepo = new InMemoryOutboxRepository();
    }
  }

  // Concurrency mutex locks mapped by paymentId to guarantee serial transaction safety
  private paymentLocks = new Map<string, Promise<void>>();

  private async acquireLock(paymentId: string): Promise<() => void> {
    while (this.paymentLocks.has(paymentId)) {
      await this.paymentLocks.get(paymentId);
    }
    let release!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.paymentLocks.set(paymentId, lockPromise);

    return () => {
      this.paymentLocks.delete(paymentId);
      release();
    };
  }

  public async saveMerchant(merchant: MerchantEntity): Promise<void> {
    this.merchants.set(merchant.id, { ...merchant });
  }

  public async saveCustomer(customer: CustomerEntity): Promise<void> {
    this.customers.set(customer.id, { ...customer });
  }

  public async findMerchantById(id: string): Promise<MerchantEntity | null> {
    return this.merchants.get(id) || null;
  }

  public async findCustomerById(id: string): Promise<CustomerEntity | null> {
    return this.customers.get(id) || null;
  }

  public async findPaymentById(id: string): Promise<PaymentEntity | null> {
    return this.payments.get(id) || null;
  }

  public async findPaymentWithDetails(
    id: string
  ): Promise<{ payment: PaymentEntity; merchant: MerchantEntity; customer: CustomerEntity; auditLogs: AuditLogEntity[] } | null> {
    const payment = this.payments.get(id);
    if (!payment) return null;

    const merchant = this.merchants.get(payment.merchantId);
    const customer = this.customers.get(payment.customerId);
    if (!merchant || !customer) return null;

    const logs = this.auditLogs.filter((l) => l.entityType === 'PAYMENT' && l.entityId === id);

    return {
      payment: { ...payment },
      merchant: { ...merchant },
      customer: { ...customer },
      auditLogs: [...logs],
    };
  }

  public async findPayments(filter: PaymentFilter): Promise<{ payments: PaymentEntity[]; total: number }> {
    let result = Array.from(this.payments.values());

    if (filter.merchantId) {
      result = result.filter((p) => p.merchantId === filter.merchantId);
    }
    if (filter.status) {
      result = result.filter((p) => p.status === filter.status);
    }
    if (filter.fromDate) {
      result = result.filter((p) => p.createdAt >= filter.fromDate!);
    }
    if (filter.toDate) {
      result = result.filter((p) => p.createdAt <= filter.toDate!);
    }

    result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = result.length;
    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const startIndex = (page - 1) * limit;
    const paginated = result.slice(startIndex, startIndex + limit);

    return { payments: paginated.map((p) => ({ ...p })), total };
  }

  public async create(data: CreatePaymentInput): Promise<PaymentEntity> {
    return this.createPayment(data);
  }

  public async createPayment(data: CreatePaymentInput): Promise<PaymentEntity> {
    const paymentId = crypto.randomUUID();
    const now = new Date();

    const payment: PaymentEntity = {
      id: paymentId,
      merchantId: data.merchantId,
      customerId: data.customerId,
      amountMinor: data.amountMinor,
      currency: data.currency,
      status: 'CREATED',
      idempotencyKey: data.idempotencyKey || null,
      capturedAmountMinor: 0n,
      refundedAmountMinor: 0n,
      description: data.description || null,
      metadata: data.metadata || null,
      createdAt: now,
      updatedAt: now,
    };

    this.payments.set(paymentId, payment);

    this.auditLogs.push({
      id: crypto.randomUUID(),
      entityType: 'PAYMENT',
      entityId: paymentId,
      action: 'PAYMENT_CREATED',
      actorId: data.actorId || 'system',
      actorType: 'SYSTEM',
      changes: {
        status: 'CREATED',
        amountMinor: data.amountMinor.toString(),
        currency: data.currency,
      },
      correlationId: data.correlationId || null,
      createdAt: now,
    });

    await this.outboxRepo.saveEvent({
      eventType: 'payment.created',
      aggregateType: 'payment',
      aggregateId: paymentId,
      payload: {
        payment_id: paymentId,
        merchant_id: data.merchantId,
        customer_id: data.customerId,
        amount_minor: Number(data.amountMinor),
        currency: data.currency,
        status: 'CREATED',
        idempotency_key: data.idempotencyKey || null,
        description: data.description || null,
      },
      topic: KafkaTopics.PAYMENT_EVENTS,
      partitionKey: paymentId,
      correlationId: data.correlationId,
    });

    return { ...payment };
  }

  public async transitionPaymentStatus(
    paymentId: string,
    expectedStatus: PaymentStatus,
    targetStatus: PaymentStatus,
    actorId?: string,
    correlationId?: string
  ): Promise<PaymentEntity> {
    // Acquire mutex lock on this specific payment ID to simulate PostgreSQL row-level pessimistic locking
    const release = await this.acquireLock(paymentId);
    try {
      // Artificial delay to simulate real network/DB I/O and surface any concurrency race conditions
      await new Promise((r) => setTimeout(r, 10));

      const payment = this.payments.get(paymentId);
      if (!payment) {
        throw new NotFoundError('Payment', paymentId);
      }

      if (payment.status !== expectedStatus) {
        throw new ConflictError(
          `Cannot transition payment '${paymentId}' from '${payment.status}' to '${targetStatus}'. Expected status: '${expectedStatus}'.`,
          { currentStatus: payment.status, expectedStatus, targetStatus }
        );
      }

      PaymentStateMachine.assertValidTransition(payment.status, targetStatus);

      const previousStatus = payment.status;
      const now = new Date();
      payment.status = targetStatus;
      payment.updatedAt = now;

      if (targetStatus === 'CAPTURED') {
        payment.capturedAmountMinor = payment.amountMinor;
      }

      this.payments.set(paymentId, payment);

      this.auditLogs.push({
        id: crypto.randomUUID(),
        entityType: 'PAYMENT',
        entityId: paymentId,
        action: 'STATE_TRANSITION',
        actorId: actorId || 'system',
        actorType: 'API',
        changes: {
          previousStatus,
          newStatus: targetStatus,
        },
        correlationId: correlationId || null,
        createdAt: now,
      });

      const eventType = `payment.${targetStatus.toLowerCase()}`;
      await this.outboxRepo.saveEvent({
        eventType,
        aggregateType: 'payment',
        aggregateId: paymentId,
        payload: {
          payment_id: paymentId,
          merchant_id: payment.merchantId,
          customer_id: payment.customerId,
          amount_minor: Number(payment.amountMinor),
          captured_amount_minor: Number(payment.capturedAmountMinor),
          currency: payment.currency,
          previous_status: previousStatus,
          new_status: targetStatus,
        },
        topic: KafkaTopics.PAYMENT_EVENTS,
        partitionKey: paymentId,
        correlationId,
      });

      return { ...payment };
    } finally {
      release();
    }
  }

  public async findRefundById(id: string): Promise<RefundEntity | null> {
    return this.refunds.get(id) || null;
  }

  public async findRefundsByPaymentId(
    paymentId: string,
    page: number,
    limit: number
  ): Promise<{ refunds: RefundEntity[]; total: number }> {
    const list = Array.from(this.refunds.values())
      .filter((r) => r.paymentId === paymentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = list.length;
    const startIndex = (page - 1) * limit;
    const paginated = list.slice(startIndex, startIndex + limit).map((r) => ({ ...r }));

    return { refunds: paginated, total };
  }

  public async executeRefund(
    paymentId: string,
    refundAmountMinor: bigint,
    reason?: string,
    idempotencyKey?: string,
    actorId?: string,
    correlationId?: string
  ): Promise<{ refund: RefundEntity; payment: PaymentEntity }> {
    const release = await this.acquireLock(paymentId);
    try {
      // Artificial delay to test concurrency race conditions
      await new Promise((r) => setTimeout(r, 10));

      const payment = this.payments.get(paymentId);
      if (!payment) {
        throw new NotFoundError('Payment', paymentId);
      }

      if (payment.status !== 'CAPTURED' && payment.status !== 'PARTIALLY_REFUNDED') {
        throw new InvalidStateTransitionError(
          payment.status,
          'REFUNDED',
          `Cannot refund payment in status '${payment.status}'. Payment must be CAPTURED or PARTIALLY_REFUNDED.`
        );
      }

      const remainingRefundable = payment.capturedAmountMinor - payment.refundedAmountMinor;
      if (refundAmountMinor > remainingRefundable) {
        throw new RefundAmountExceededError(
          `Refund amount of ${refundAmountMinor} minor units exceeds remaining refundable amount of ${remainingRefundable} minor units.`
        );
      }

      const now = new Date();
      const refundId = crypto.randomUUID();
      const newRefundedTotal = payment.refundedAmountMinor + refundAmountMinor;
      const isFullRefund = newRefundedTotal === payment.capturedAmountMinor;
      const targetPaymentStatus: PaymentStatus = isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

      const refund: RefundEntity = {
        id: refundId,
        paymentId,
        merchantId: payment.merchantId,
        amountMinor: refundAmountMinor,
        currency: payment.currency,
        status: 'COMPLETED',
        idempotencyKey: idempotencyKey || null,
        reason: reason || null,
        createdAt: now,
        updatedAt: now,
      };

      this.refunds.set(refundId, refund);

      // Update payment
      payment.refundedAmountMinor = newRefundedTotal;
      payment.status = targetPaymentStatus;
      payment.updatedAt = now;
      this.payments.set(paymentId, payment);

      this.auditLogs.push({
        id: crypto.randomUUID(),
        entityType: 'REFUND',
        entityId: refundId,
        action: 'REFUND_COMPLETED',
        actorId: actorId || 'system',
        actorType: 'API',
        changes: {
          paymentId,
          refundAmountMinor: refundAmountMinor.toString(),
          totalRefundedMinor: newRefundedTotal.toString(),
          newPaymentStatus: targetPaymentStatus,
        },
        correlationId: correlationId || null,
        createdAt: now,
      });

      await this.outboxRepo.saveEvent({
        eventType: 'refund.created',
        aggregateType: 'refund',
        aggregateId: refundId,
        payload: {
          refund_id: refundId,
          payment_id: paymentId,
          merchant_id: payment.merchantId,
          amount_minor: Number(refundAmountMinor),
          currency: payment.currency,
          status: 'COMPLETED',
          reason: reason || null,
        },
        topic: KafkaTopics.REFUND_EVENTS,
        partitionKey: paymentId,
        correlationId,
      });

      await this.outboxRepo.saveEvent({
        eventType: 'refund.completed',
        aggregateType: 'refund',
        aggregateId: refundId,
        payload: {
          refund_id: refundId,
          payment_id: paymentId,
          merchant_id: payment.merchantId,
          amount_minor: Number(refundAmountMinor),
          currency: payment.currency,
          status: 'COMPLETED',
          reason: reason || null,
        },
        topic: KafkaTopics.REFUND_EVENTS,
        partitionKey: paymentId,
        correlationId,
      });

      return { refund: { ...refund }, payment: { ...payment } };
    } finally {
      release();
    }
  }

  public clear(): void {
    this.merchants.clear();
    this.customers.clear();
    this.payments.clear();
    this.refunds.clear();
    this.auditLogs = [];
  }
}

/**
 * Production PostgreSQL Prisma-backed Payment Repository
 * Employs row-level locking via transactions to guarantee ACID concurrency safety.
 */
export class PrismaPaymentRepository implements IPaymentRepository {
  private prisma = getPrismaClient();
  private outboxRepo: IOutboxRepository;

  constructor(
    prismaClient = getPrismaClient(),
    outboxRepo: IOutboxRepository = getOutboxRepository()
  ) {
    this.prisma = prismaClient;
    this.outboxRepo = outboxRepo;
  }

  public async saveMerchant(merchant: MerchantEntity): Promise<void> {
    await this.prisma.merchant.upsert({
      where: { id: merchant.id },
      create: {
        id: merchant.id,
        businessName: merchant.businessName,
        status: merchant.status,
        apiKeyHash: merchant.apiKeyHash,
        webhookUrl: merchant.webhookUrl,
      },
      update: {
        businessName: merchant.businessName,
        status: merchant.status,
      },
    });
  }

  public async saveCustomer(customer: CustomerEntity): Promise<void> {
    await this.prisma.customer.upsert({
      where: { id: customer.id },
      create: {
        id: customer.id,
        merchantId: customer.merchantId,
        name: customer.name,
        email: customer.email,
      },
      update: {
        name: customer.name,
        email: customer.email,
      },
    });
  }

  public async findMerchantById(id: string): Promise<MerchantEntity | null> {
    const row = await this.prisma.merchant.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      businessName: row.businessName,
      status: row.status,
      apiKeyHash: row.apiKeyHash,
      webhookUrl: row.webhookUrl,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public async findCustomerById(id: string): Promise<CustomerEntity | null> {
    const row = await this.prisma.customer.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: row.id,
      merchantId: row.merchantId,
      name: row.name,
      email: row.email,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public async findPaymentById(id: string): Promise<PaymentEntity | null> {
    const row = await this.prisma.payment.findUnique({ where: { id } });
    if (!row) return null;
    return this.mapPrismaPayment(row);
  }

  public async findPaymentWithDetails(
    id: string
  ): Promise<{ payment: PaymentEntity; merchant: MerchantEntity; customer: CustomerEntity; auditLogs: AuditLogEntity[] } | null> {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        merchant: true,
        customer: true,
      },
    });
    if (!row) return null;

    const auditRows = await this.prisma.auditLog.findMany({
      where: { entityType: 'PAYMENT', entityId: id },
      orderBy: { createdAt: 'asc' },
    });

    return {
      payment: this.mapPrismaPayment(row),
      merchant: {
        id: row.merchant.id,
        userId: row.merchant.userId,
        businessName: row.merchant.businessName,
        status: row.merchant.status,
        apiKeyHash: row.merchant.apiKeyHash,
        webhookUrl: row.merchant.webhookUrl,
        createdAt: row.merchant.createdAt,
        updatedAt: row.merchant.updatedAt,
      },
      customer: {
        id: row.customer.id,
        merchantId: row.customer.merchantId,
        name: row.customer.name,
        email: row.customer.email,
        createdAt: row.customer.createdAt,
        updatedAt: row.customer.updatedAt,
      },
      auditLogs: auditRows.map((a) => ({
        id: a.id,
        entityType: a.entityType,
        entityId: a.entityId,
        action: a.action,
        actorId: a.actorId,
        actorType: a.actorType,
        changes: a.changes as Record<string, unknown> | null,
        correlationId: a.correlationId,
        createdAt: a.createdAt,
      })),
    };
  }

  public async findPayments(filter: PaymentFilter): Promise<{ payments: PaymentEntity[]; total: number }> {
    const where: {
      merchantId?: string;
      status?: PaymentStatus;
      createdAt?: { gte?: Date; lte?: Date };
    } = {};

    if (filter.merchantId) where.merchantId = filter.merchantId;
    if (filter.status) where.status = filter.status;
    if (filter.fromDate || filter.toDate) {
      where.createdAt = {};
      if (filter.fromDate) where.createdAt.gte = filter.fromDate;
      if (filter.toDate) where.createdAt.lte = filter.toDate;
    }

    const [total, rows] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
      }),
    ]);

    return {
      payments: rows.map((r) => this.mapPrismaPayment(r)),
      total,
    };
  }

  public async createPayment(data: CreatePaymentInput): Promise<PaymentEntity> {
    return await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          merchantId: data.merchantId,
          customerId: data.customerId,
          amountMinor: data.amountMinor,
          currency: data.currency,
          status: 'CREATED',
          idempotencyKey: data.idempotencyKey,
          description: data.description,
          metadata: (data.metadata || {}) as object,
        },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'PAYMENT',
          entityId: payment.id,
          action: 'PAYMENT_CREATED',
          actorId: data.actorId || 'system',
          actorType: 'SYSTEM',
          changes: {
            status: 'CREATED',
            amountMinor: data.amountMinor.toString(),
            currency: data.currency,
          },
          correlationId: data.correlationId,
        },
      });

      await this.outboxRepo.saveEvent(
        {
          eventType: 'payment.created',
          aggregateType: 'payment',
          aggregateId: payment.id,
          payload: {
            payment_id: payment.id,
            merchant_id: data.merchantId,
            customer_id: data.customerId,
            amount_minor: Number(data.amountMinor),
            currency: data.currency,
            status: 'CREATED',
            idempotency_key: data.idempotencyKey || null,
            description: data.description || null,
          },
          topic: KafkaTopics.PAYMENT_EVENTS,
          partitionKey: payment.id,
          correlationId: data.correlationId,
        },
        tx
      );

      return this.mapPrismaPayment(payment);
    });
  }

  /**
   * Concurrency Safe Transition Strategy:
   * Uses raw PostgreSQL SELECT ... FOR UPDATE within an explicit transaction to serialize access.
   */
  public async transitionPaymentStatus(
    paymentId: string,
    expectedStatus: PaymentStatus,
    targetStatus: PaymentStatus,
    actorId?: string,
    correlationId?: string
  ): Promise<PaymentEntity> {
    return await this.prisma.$transaction(async (tx) => {
      // Pessimistic lock row for update
      const rows = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          merchant_id: string;
          customer_id: string;
          currency: string;
          status: PaymentStatus;
          amount_minor: bigint;
          captured_amount_minor: bigint;
        }>
      >(
        `SELECT id, merchant_id, customer_id, currency, status, amount_minor, captured_amount_minor FROM payments WHERE id = $1::uuid FOR UPDATE`,
        paymentId
      );

      const locked = rows[0];
      if (!locked) {
        throw new NotFoundError('Payment', paymentId);
      }

      if (locked.status !== expectedStatus) {
        throw new ConflictError(
          `Cannot transition payment '${paymentId}' from '${locked.status}' to '${targetStatus}'. Expected status: '${expectedStatus}'.`,
          { currentStatus: locked.status, expectedStatus, targetStatus }
        );
      }

      PaymentStateMachine.assertValidTransition(locked.status, targetStatus);

      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: targetStatus,
          capturedAmountMinor: targetStatus === 'CAPTURED' ? locked.amount_minor : undefined,
        },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'PAYMENT',
          entityId: paymentId,
          action: 'STATE_TRANSITION',
          actorId: actorId || 'system',
          actorType: 'API',
          changes: {
            previousStatus: locked.status,
            newStatus: targetStatus,
          },
          correlationId,
        },
      });

      const eventType = `payment.${targetStatus.toLowerCase()}`;
      await this.outboxRepo.saveEvent(
        {
          eventType,
          aggregateType: 'payment',
          aggregateId: paymentId,
          payload: {
            payment_id: paymentId,
            merchant_id: locked.merchant_id,
            customer_id: locked.customer_id,
            amount_minor: Number(locked.amount_minor),
            captured_amount_minor: targetStatus === 'CAPTURED' ? Number(locked.amount_minor) : Number(locked.captured_amount_minor || 0),
            currency: locked.currency,
            previous_status: locked.status,
            new_status: targetStatus,
          },
          topic: KafkaTopics.PAYMENT_EVENTS,
          partitionKey: paymentId,
          correlationId,
        },
        tx
      );

      return this.mapPrismaPayment(updated);
    });
  }

  public async findRefundById(id: string): Promise<RefundEntity | null> {
    const row = await this.prisma.refund.findUnique({ where: { id } });
    if (!row) return null;
    return this.mapPrismaRefund(row);
  }

  public async findRefundsByPaymentId(
    paymentId: string,
    page: number,
    limit: number
  ): Promise<{ refunds: RefundEntity[]; total: number }> {
    const where = { paymentId };
    const [total, rows] = await Promise.all([
      this.prisma.refund.count({ where }),
      this.prisma.refund.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      refunds: rows.map((r) => this.mapPrismaRefund(r)),
      total,
    };
  }

  public async executeRefund(
    paymentId: string,
    refundAmountMinor: bigint,
    reason?: string,
    idempotencyKey?: string,
    actorId?: string,
    correlationId?: string
  ): Promise<{ refund: RefundEntity; payment: PaymentEntity }> {
    return await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          merchant_id: string;
          currency: string;
          status: PaymentStatus;
          captured_amount_minor: bigint;
          refunded_amount_minor: bigint;
        }>
      >(
        `SELECT id, merchant_id, currency, status, captured_amount_minor, refunded_amount_minor FROM payments WHERE id = $1::uuid FOR UPDATE`,
        paymentId
      );

      const locked = rows[0];
      if (!locked) {
        throw new NotFoundError('Payment', paymentId);
      }

      if (locked.status !== 'CAPTURED' && locked.status !== 'PARTIALLY_REFUNDED') {
        throw new InvalidStateTransitionError(
          locked.status,
          'REFUNDED',
          `Cannot refund payment in status '${locked.status}'. Payment must be CAPTURED or PARTIALLY_REFUNDED.`
        );
      }

      const remainingRefundable = BigInt(locked.captured_amount_minor) - BigInt(locked.refunded_amount_minor);
      if (refundAmountMinor > remainingRefundable) {
        throw new RefundAmountExceededError(
          `Refund amount of ${refundAmountMinor} minor units exceeds remaining refundable amount of ${remainingRefundable} minor units.`
        );
      }

      const newRefundedTotal = BigInt(locked.refunded_amount_minor) + refundAmountMinor;
      const isFullRefund = newRefundedTotal === BigInt(locked.captured_amount_minor);
      const targetPaymentStatus: PaymentStatus = isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

      const refund = await tx.refund.create({
        data: {
          paymentId,
          merchantId: locked.merchant_id,
          amountMinor: refundAmountMinor,
          currency: locked.currency,
          status: 'COMPLETED',
          idempotencyKey: idempotencyKey || null,
          reason: reason || null,
        },
      });

      const updatedPayment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: targetPaymentStatus,
          refundedAmountMinor: newRefundedTotal,
        },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'REFUND',
          entityId: refund.id,
          action: 'REFUND_COMPLETED',
          actorId: actorId || 'system',
          actorType: 'API',
          changes: {
            paymentId,
            refundAmountMinor: refundAmountMinor.toString(),
            totalRefundedMinor: newRefundedTotal.toString(),
            newPaymentStatus: targetPaymentStatus,
          },
          correlationId: correlationId || null,
        },
      });

      await this.outboxRepo.saveEvent(
        {
          eventType: 'refund.created',
          aggregateType: 'refund',
          aggregateId: refund.id,
          payload: {
            refund_id: refund.id,
            payment_id: paymentId,
            merchant_id: locked.merchant_id,
            amount_minor: Number(refundAmountMinor),
            currency: locked.currency,
            status: 'COMPLETED',
            reason: reason || null,
          },
          topic: KafkaTopics.REFUND_EVENTS,
          partitionKey: paymentId,
          correlationId,
        },
        tx
      );

      await this.outboxRepo.saveEvent(
        {
          eventType: 'refund.completed',
          aggregateType: 'refund',
          aggregateId: refund.id,
          payload: {
            refund_id: refund.id,
            payment_id: paymentId,
            merchant_id: locked.merchant_id,
            amount_minor: Number(refundAmountMinor),
            currency: locked.currency,
            status: 'COMPLETED',
            reason: reason || null,
          },
          topic: KafkaTopics.REFUND_EVENTS,
          partitionKey: paymentId,
          correlationId,
        },
        tx
      );

      return {
        refund: this.mapPrismaRefund(refund),
        payment: this.mapPrismaPayment(updatedPayment),
      };
    });
  }

  private mapPrismaRefund(row: {
    id: string;
    paymentId: string;
    merchantId: string;
    amountMinor: bigint;
    currency: string;
    status: RefundStatus;
    idempotencyKey: string | null;
    reason: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): RefundEntity {
    return {
      id: row.id,
      paymentId: row.paymentId,
      merchantId: row.merchantId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      status: row.status,
      idempotencyKey: row.idempotencyKey,
      reason: row.reason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapPrismaPayment(row: {
    id: string;
    merchantId: string;
    customerId: string;
    amountMinor: bigint;
    currency: string;
    status: PaymentStatus;
    idempotencyKey: string | null;
    capturedAmountMinor: bigint;
    refundedAmountMinor: bigint;
    description: string | null;
    metadata: unknown;
    createdAt: Date;
    updatedAt: Date;
  }): PaymentEntity {
    return {
      id: row.id,
      merchantId: row.merchantId,
      customerId: row.customerId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      status: row.status,
      idempotencyKey: row.idempotencyKey,
      capturedAmountMinor: row.capturedAmountMinor,
      refundedAmountMinor: row.refundedAmountMinor,
      description: row.description,
      metadata: row.metadata as Record<string, unknown> | null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
