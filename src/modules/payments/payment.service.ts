import {
  IPaymentRepository,
  PaymentEntity,
  PaymentFilter,
  RefundEntity,
} from './payment.repository.js';
import { PaymentStatus, PaymentStateMachine, RefundStatus } from './payment-state-machine.js';
import {
  NotFoundError,
  ValidationError,
  FinancialInvarianceError,
  InvalidStateTransitionError,
} from '../../common/errors.js';
import { SUPPORTED_CURRENCIES } from '../../common/money.js';
import { logger } from '../../common/logger.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import {
  RedisCacheService,
  getRedisCacheService,
} from '../../infra/redis/redis-cache.service.js';
import {
  RedisLockService,
  getRedisLockService,
} from '../../infra/redis/redis-lock.service.js';
import { RedisKeys } from '../../infra/redis/redis.keys.js';
import { config } from '../../config/index.js';

export interface RequestContext {
  actorId?: string;
  correlationId?: string;
  requestId?: string;
}

export interface CreatePaymentDto {
  merchant_id: string;
  customer_id: string;
  amount_minor: bigint | number;
  currency: string;
  description?: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentResponseDto {
  id: string;
  merchant_id: string;
  customer_id: string;
  amount_minor: number;
  currency: string;
  status: PaymentStatus;
  captured_amount_minor: number;
  refunded_amount_minor: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundResponseDto {
  id: string;
  payment_id: string;
  merchant_id: string;
  amount_minor: number;
  currency: string;
  status: RefundStatus;
  idempotency_key: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentDetailResponseDto extends PaymentResponseDto {
  merchant: {
    id: string;
    business_name: string;
    status: string;
  };
  customer: {
    id: string;
    name: string;
    email: string;
  };
  audit_logs: Array<{
    id: string;
    action: string;
    actor_id: string | null;
    changes: Record<string, unknown> | null;
    created_at: string;
  }>;
}

export class PaymentService {
  constructor(
    private readonly repository: IPaymentRepository,
    private readonly ledgerService?: LedgerService,
    private readonly cacheService: RedisCacheService = getRedisCacheService(),
    private readonly lockService: RedisLockService = getRedisLockService()
  ) {}

  public async createPayment(dto: CreatePaymentDto, context: RequestContext = {}): Promise<PaymentResponseDto> {
    const amountMinorBigInt = typeof dto.amount_minor === 'bigint' ? dto.amount_minor : BigInt(dto.amount_minor);

    if (amountMinorBigInt <= 0n) {
      throw new ValidationError('Payment amount must be greater than zero minor units');
    }

    const currencyNormalized = dto.currency.toUpperCase();
    if (!SUPPORTED_CURRENCIES[currencyNormalized]) {
      throw new FinancialInvarianceError(
        `Unsupported currency '${dto.currency}'. Supported currencies: ${Object.keys(SUPPORTED_CURRENCIES).join(', ')}`
      );
    }

    // 1. Verify merchant exists
    const merchant = await this.repository.findMerchantById(dto.merchant_id);
    if (!merchant) {
      throw new NotFoundError('Merchant', dto.merchant_id);
    }
    if (merchant.status !== 'ACTIVE') {
      throw new ValidationError(`Merchant '${dto.merchant_id}' is inactive and cannot process payments`);
    }

    // 2. Verify customer exists
    const customer = await this.repository.findCustomerById(dto.customer_id);
    if (!customer) {
      throw new NotFoundError('Customer', dto.customer_id);
    }

    // 3. Verify customer belongs to the merchant
    if (customer.merchantId !== dto.merchant_id) {
      throw new ValidationError(
        `Customer '${dto.customer_id}' does not belong to merchant '${dto.merchant_id}'`
      );
    }

    const payment = await this.repository.createPayment({
      merchantId: dto.merchant_id,
      customerId: dto.customer_id,
      amountMinor: amountMinorBigInt,
      currency: currencyNormalized,
      description: dto.description,
      idempotencyKey: dto.idempotency_key,
      metadata: dto.metadata,
      actorId: context.actorId,
      correlationId: context.correlationId,
    });

    logger.info(`Payment created successfully: ${payment.id}`, {
      correlationId: context.correlationId,
      requestId: context.requestId,
      event: 'payment.created',
      status: 'SUCCESS',
      paymentId: payment.id,
      merchantId: payment.merchantId,
      amountMinor: Number(payment.amountMinor),
      currency: payment.currency,
    });

    return this.toResponseDto(payment);
  }

  public async getPaymentById(id: string): Promise<PaymentDetailResponseDto> {
    const cacheKey = RedisKeys.paymentCache(id);
    const cached = await this.cacheService.get<PaymentDetailResponseDto>(cacheKey);
    if (cached) {
      return cached;
    }

    const details = await this.repository.findPaymentWithDetails(id);
    if (!details) {
      throw new NotFoundError('Payment', id);
    }

    const dto: PaymentDetailResponseDto = {
      ...this.toResponseDto(details.payment),
      merchant: {
        id: details.merchant.id,
        business_name: details.merchant.businessName,
        status: details.merchant.status,
      },
      customer: {
        id: details.customer.id,
        name: details.customer.name,
        email: details.customer.email,
      },
      audit_logs: details.auditLogs.map((l) => ({
        id: l.id,
        action: l.action,
        actor_id: l.actorId ?? null,
        changes: l.changes ?? null,
        created_at: l.createdAt.toISOString(),
      })),
    };

    await this.cacheService.set(cacheKey, dto, config.CACHE_TTL_PAYMENT_SECS);
    return dto;
  }

  public async listPayments(
    filter: PaymentFilter
  ): Promise<{ payments: PaymentResponseDto[]; total: number; page: number; limit: number; totalPages: number }> {
    const { payments, total } = await this.repository.findPayments(filter);
    const totalPages = Math.ceil(total / filter.limit) || 1;

    return {
      payments: payments.map((p) => this.toResponseDto(p)),
      total,
      page: filter.page,
      limit: filter.limit,
      totalPages,
    };
  }

  /**
   * Transition: CREATED -> PENDING
   */
  public async initiatePayment(paymentId: string, context: RequestContext = {}): Promise<PaymentResponseDto> {
    return this.executeTransition(paymentId, 'CREATED', 'PENDING', context);
  }

  /**
   * Transition: PENDING -> AUTHORIZED
   */
  public async authorizePayment(paymentId: string, context: RequestContext = {}): Promise<PaymentResponseDto> {
    return this.executeTransition(paymentId, 'PENDING', 'AUTHORIZED', context);
  }

  /**
   * Transition: AUTHORIZED -> CAPTURED
   */
  public async capturePayment(paymentId: string, context: RequestContext = {}): Promise<PaymentResponseDto> {
    const lock = await this.lockService.acquireLock(paymentId);
    try {
      const updated = await this.executeTransition(paymentId, 'AUTHORIZED', 'CAPTURED', context);

      if (this.ledgerService) {
        const payment = await this.repository.findPaymentById(paymentId);
        if (payment) {
          await this.ledgerService.recordPaymentCapture(payment, context);
        }
      }

      await this.cacheService.del(RedisKeys.paymentCache(paymentId));
      return updated;
    } finally {
      await lock.release();
    }
  }

  /**
   * Transition: PENDING -> CANCELLED or AUTHORIZED -> CANCELLED
   */
  public async cancelPayment(paymentId: string, context: RequestContext = {}): Promise<PaymentResponseDto> {
    const payment = await this.repository.findPaymentById(paymentId);
    if (!payment) {
      throw new NotFoundError('Payment', paymentId);
    }

    if (payment.status !== 'PENDING' && payment.status !== 'AUTHORIZED') {
      throw new InvalidStateTransitionError(payment.status, 'CANCELLED');
    }

    return this.executeTransition(paymentId, payment.status, 'CANCELLED', context);
  }

  /**
   * Transition: CREATED -> FAILED or PENDING -> FAILED
   */
  public async failPayment(paymentId: string, context: RequestContext = {}): Promise<PaymentResponseDto> {
    const payment = await this.repository.findPaymentById(paymentId);
    if (!payment) {
      throw new NotFoundError('Payment', paymentId);
    }

    if (payment.status !== 'CREATED' && payment.status !== 'PENDING') {
      throw new InvalidStateTransitionError(payment.status, 'FAILED');
    }

    return this.executeTransition(paymentId, payment.status, 'FAILED', context);
  }

  /**
   * Transition: CAPTURED -> SETTLED
   */
  public async settlePayment(paymentId: string, context: RequestContext = {}): Promise<PaymentResponseDto> {
    return this.executeTransition(paymentId, 'CAPTURED', 'SETTLED', context);
  }

  /**
   * Applies downstream Risk Decision from Risk Engine.
   * If BLOCK: transitions payment to FAILED if in CREATED or PENDING state.
   * If REVIEW / ALLOW: records decision and leaves in current state.
   */
  public async applyRiskDecision(
    paymentId: string,
    decision: 'ALLOW' | 'REVIEW' | 'BLOCK',
    reason?: string,
    context: RequestContext = {}
  ): Promise<PaymentResponseDto | null> {
    const payment = await this.repository.findPaymentById(paymentId);
    if (!payment) {
      throw new NotFoundError('Payment', paymentId);
    }

    if (decision === 'BLOCK') {
      if (payment.status === 'CREATED' || payment.status === 'PENDING') {
        logger.warn(`Payment ${paymentId} blocked by Risk Engine: ${reason || 'High risk score'}`);
        payment.metadata = {
          ...(payment.metadata || {}),
          risk_decision: decision,
          failure_reason: `Blocked by Risk Engine: ${reason || 'High risk score'}`,
        };
        return this.failPayment(paymentId, {
          ...context,
          actorId: context.actorId || 'risk-engine',
        });
      }
    } else {
      payment.metadata = {
        ...(payment.metadata || {}),
        risk_decision: decision,
      };
    }

    logger.info(`Payment ${paymentId} risk decision '${decision}' recorded`, {
      paymentId,
      decision,
      status: payment.status,
    });
    return this.toResponseDto(payment);
  }

  private async executeTransition(
    paymentId: string,
    expectedStatus: PaymentStatus,
    targetStatus: PaymentStatus,
    context: RequestContext
  ): Promise<PaymentResponseDto> {
    // 1. Verify existence
    const current = await this.repository.findPaymentById(paymentId);
    if (!current) {
      throw new NotFoundError('Payment', paymentId);
    }

    // 2. Validate state machine transition graph
    PaymentStateMachine.assertValidTransition(current.status, targetStatus);

    if (current.status !== expectedStatus) {
      throw new InvalidStateTransitionError(
        current.status,
        targetStatus,
        `Payment is currently in state '${current.status}', cannot transition to '${targetStatus}'`
      );
    }

    // 3. Atomically transition with database row-level locking
    const updated = await this.repository.transitionPaymentStatus(
      paymentId,
      expectedStatus,
      targetStatus,
      context.actorId,
      context.correlationId
    );

    // 4. Invalidate cached payment state
    await this.cacheService.del(RedisKeys.paymentCache(paymentId));

    logger.info(`Payment status transitioned: ${paymentId} (${expectedStatus} -> ${targetStatus})`, {
      correlationId: context.correlationId,
      requestId: context.requestId,
      event: 'payment.transition',
      status: 'SUCCESS',
      paymentId,
      previousStatus: expectedStatus,
      newStatus: targetStatus,
    });

    return this.toResponseDto(updated);
  }

  /**
   * Transition & Financial Execution: CAPTURED | PARTIALLY_REFUNDED -> PARTIALLY_REFUNDED | REFUNDED
   * Atomically executes refund with database locks, verifies remaining refundable balance,
   * updates payment status, records compensating double-entry ledger journal, and audits event.
   */
  public async refundPayment(
    paymentId: string,
    amountMinor: number | bigint,
    reason?: string,
    idempotencyKey?: string,
    context: RequestContext = {}
  ): Promise<RefundResponseDto> {
    const refundBigInt = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor);
    if (refundBigInt <= 0n) {
      throw new ValidationError('Refund amount must be greater than zero');
    }

    // Acquire Redis distributed lock around high-contention refund execution
    const lock = await this.lockService.acquireLock(paymentId);
    try {
      // 1. Execute atomic refund in repository (includes row lock, balance checks, payment status update, and audit log)
      const { refund, payment } = await this.repository.executeRefund(
        paymentId,
        refundBigInt,
        reason,
        idempotencyKey,
        context.actorId,
        context.correlationId
      );

      // 2. Record compensating double-entry ledger transaction
      if (this.ledgerService) {
        await this.ledgerService.recordPaymentRefund(refund, context);
      }

      // 3. Cache Invalidation: invalidate both payment cache and refund list cache
      await this.cacheService.del(RedisKeys.paymentCache(paymentId));
      await this.cacheService.del(RedisKeys.refundsCache(paymentId));

      logger.info(`Payment refund executed: ${refund.id} for payment ${paymentId}`, {
        correlationId: context.correlationId,
        requestId: context.requestId,
        event: 'payment.refund',
        status: 'SUCCESS',
        refundId: refund.id,
        paymentId,
        refundAmountMinor: Number(refund.amountMinor),
        newPaymentStatus: payment.status,
      });

      return this.toRefundResponseDto(refund);
    } finally {
      await lock.release();
    }
  }

  public async getRefundById(refundId: string): Promise<RefundResponseDto> {
    const refund = await this.repository.findRefundById(refundId);
    if (!refund) {
      throw new NotFoundError('Refund', refundId);
    }
    return this.toRefundResponseDto(refund);
  }

  public async listPaymentRefunds(
    paymentId: string,
    page: number = 1,
    limit: number = 20
  ): Promise<{
    refunds: RefundResponseDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const payment = await this.repository.findPaymentById(paymentId);
    if (!payment) {
      throw new NotFoundError('Payment', paymentId);
    }

    const cacheKey = `${RedisKeys.refundsCache(paymentId)}:p${page}:l${limit}`;
    const cached = await this.cacheService.get<{
      refunds: RefundResponseDto[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }>(cacheKey);
    if (cached) {
      return cached;
    }

    const { refunds, total } = await this.repository.findRefundsByPaymentId(paymentId, page, limit);
    const totalPages = Math.ceil(total / limit) || 1;

    const result = {
      refunds: refunds.map((r) => this.toRefundResponseDto(r)),
      total,
      page,
      limit,
      totalPages,
    };

    await this.cacheService.set(cacheKey, result, config.CACHE_TTL_PAYMENT_SECS);
    return result;
  }

  private toRefundResponseDto(entity: RefundEntity): RefundResponseDto {
    return {
      id: entity.id,
      payment_id: entity.paymentId,
      merchant_id: entity.merchantId,
      amount_minor: Number(entity.amountMinor),
      currency: entity.currency,
      status: entity.status,
      idempotency_key: entity.idempotencyKey ?? null,
      reason: entity.reason ?? null,
      created_at: entity.createdAt.toISOString(),
      updated_at: entity.updatedAt.toISOString(),
    };
  }

  private toResponseDto(entity: PaymentEntity): PaymentResponseDto {
    return {
      id: entity.id,
      merchant_id: entity.merchantId,
      customer_id: entity.customerId,
      amount_minor: Number(entity.amountMinor),
      currency: entity.currency,
      status: entity.status,
      captured_amount_minor: Number(entity.capturedAmountMinor),
      refunded_amount_minor: Number(entity.refundedAmountMinor),
      description: entity.description ?? null,
      created_at: entity.createdAt.toISOString(),
      updated_at: entity.updatedAt.toISOString(),
    };
  }
}
