import { InvalidStateTransitionError } from '../../common/errors.js';

export type PaymentStatus =
  | 'CREATED'
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'FAILED'
  | 'SETTLED';

export type RefundStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

/**
 * Strict Payment State Machine Transition Graph
 *
 * Forward Path:
 *   CREATED -> PENDING -> AUTHORIZED -> CAPTURED -> SETTLED
 *
 * Failure / Cancellation Paths:
 *   CREATED -> FAILED
 *   PENDING -> FAILED
 *   PENDING -> CANCELLED
 *   AUTHORIZED -> CANCELLED
 *
 * Refund Paths:
 *   CAPTURED -> REFUND_PENDING -> REFUNDED (Full Refund)
 *   CAPTURED -> PARTIALLY_REFUNDED (Partial Refund)
 *   PARTIALLY_REFUNDED -> PARTIALLY_REFUNDED (Subsequent Partial Refund)
 *   PARTIALLY_REFUNDED -> REFUND_PENDING -> REFUNDED (Final Refund to 100%)
 */
export const VALID_PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, ReadonlySet<PaymentStatus>>> = {
  CREATED: new Set<PaymentStatus>(['PENDING', 'FAILED']),
  PENDING: new Set<PaymentStatus>(['AUTHORIZED', 'FAILED', 'CANCELLED']),
  AUTHORIZED: new Set<PaymentStatus>(['CAPTURED', 'CANCELLED']),
  CAPTURED: new Set<PaymentStatus>(['SETTLED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED']),
  PARTIALLY_REFUNDED: new Set<PaymentStatus>(['PARTIALLY_REFUNDED', 'REFUND_PENDING']),
  REFUND_PENDING: new Set<PaymentStatus>(['REFUNDED']),
  REFUNDED: new Set<PaymentStatus>([]),
  FAILED: new Set<PaymentStatus>([]),
  CANCELLED: new Set<PaymentStatus>([]),
  SETTLED: new Set<PaymentStatus>([]),
};

export class PaymentStateMachine {
  public static canTransition(currentStatus: PaymentStatus, targetStatus: PaymentStatus): boolean {
    const allowed = VALID_PAYMENT_TRANSITIONS[currentStatus];
    if (!allowed) {
      return false;
    }
    return allowed.has(targetStatus);
  }

  public static assertValidTransition(currentStatus: PaymentStatus, targetStatus: PaymentStatus): void {
    if (!this.canTransition(currentStatus, targetStatus)) {
      throw new InvalidStateTransitionError(currentStatus, targetStatus);
    }
  }

  public static getNextAllowedStates(currentStatus: PaymentStatus): PaymentStatus[] {
    const allowed = VALID_PAYMENT_TRANSITIONS[currentStatus];
    return allowed ? Array.from(allowed) : [];
  }

  public static isTerminal(status: PaymentStatus): boolean {
    const allowed = VALID_PAYMENT_TRANSITIONS[status];
    return !allowed || allowed.size === 0;
  }
}

/**
 * Strict Refund State Machine Transition Graph
 * PENDING -> PROCESSING -> COMPLETED
 *            PROCESSING -> FAILED
 */
export const VALID_REFUND_TRANSITIONS: Readonly<Record<RefundStatus, ReadonlySet<RefundStatus>>> = {
  PENDING: new Set<RefundStatus>(['PROCESSING', 'FAILED']),
  PROCESSING: new Set<RefundStatus>(['COMPLETED', 'FAILED']),
  COMPLETED: new Set<RefundStatus>([]),
  FAILED: new Set<RefundStatus>([]),
};

export class RefundStateMachine {
  public static canTransition(currentStatus: RefundStatus, targetStatus: RefundStatus): boolean {
    const allowed = VALID_REFUND_TRANSITIONS[currentStatus];
    if (!allowed) return false;
    return allowed.has(targetStatus);
  }

  public static assertValidTransition(currentStatus: RefundStatus, targetStatus: RefundStatus): void {
    if (!this.canTransition(currentStatus, targetStatus)) {
      throw new InvalidStateTransitionError(
        currentStatus,
        targetStatus,
        `Refund cannot transition from ${currentStatus} to ${targetStatus}`
      );
    }
  }

  public static isTerminal(status: RefundStatus): boolean {
    const allowed = VALID_REFUND_TRANSITIONS[status];
    return !allowed || allowed.size === 0;
  }
}
