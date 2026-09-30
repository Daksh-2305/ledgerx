import { describe, it, expect } from 'vitest';
import {
  PaymentStateMachine,
  PaymentStatus,
  VALID_PAYMENT_TRANSITIONS,
} from './payment-state-machine.js';
import { InvalidStateTransitionError } from '../../common/errors.js';

describe('Payment State Machine', () => {
  describe('Valid Forward Transitions', () => {
    it('allows CREATED -> PENDING', () => {
      expect(PaymentStateMachine.canTransition('CREATED', 'PENDING')).toBe(true);
      expect(() => PaymentStateMachine.assertValidTransition('CREATED', 'PENDING')).not.toThrow();
    });

    it('allows PENDING -> AUTHORIZED', () => {
      expect(PaymentStateMachine.canTransition('PENDING', 'AUTHORIZED')).toBe(true);
      expect(() => PaymentStateMachine.assertValidTransition('PENDING', 'AUTHORIZED')).not.toThrow();
    });

    it('allows AUTHORIZED -> CAPTURED', () => {
      expect(PaymentStateMachine.canTransition('AUTHORIZED', 'CAPTURED')).toBe(true);
      expect(() => PaymentStateMachine.assertValidTransition('AUTHORIZED', 'CAPTURED')).not.toThrow();
    });

    it('allows CAPTURED -> SETTLED', () => {
      expect(PaymentStateMachine.canTransition('CAPTURED', 'SETTLED')).toBe(true);
      expect(() => PaymentStateMachine.assertValidTransition('CAPTURED', 'SETTLED')).not.toThrow();
    });
  });

  describe('Valid Failure & Refund Paths', () => {
    it('allows CREATED -> FAILED', () => {
      expect(PaymentStateMachine.canTransition('CREATED', 'FAILED')).toBe(true);
    });

    it('allows PENDING -> FAILED', () => {
      expect(PaymentStateMachine.canTransition('PENDING', 'FAILED')).toBe(true);
    });

    it('allows PENDING -> CANCELLED', () => {
      expect(PaymentStateMachine.canTransition('PENDING', 'CANCELLED')).toBe(true);
    });

    it('allows AUTHORIZED -> CANCELLED', () => {
      expect(PaymentStateMachine.canTransition('AUTHORIZED', 'CANCELLED')).toBe(true);
    });

    it('allows CAPTURED -> REFUND_PENDING', () => {
      expect(PaymentStateMachine.canTransition('CAPTURED', 'REFUND_PENDING')).toBe(true);
    });

    it('allows REFUND_PENDING -> REFUNDED', () => {
      expect(PaymentStateMachine.canTransition('REFUND_PENDING', 'REFUNDED')).toBe(true);
    });
  });

  describe('Invalid & Forbidden Transitions', () => {
    const invalidPairs: Array<[PaymentStatus, PaymentStatus]> = [
      ['SETTLED', 'CREATED'],
      ['SETTLED', 'CAPTURED'],
      ['REFUNDED', 'CAPTURED'],
      ['CREATED', 'CAPTURED'],
      ['CAPTURED', 'PENDING'],
      ['CREATED', 'AUTHORIZED'],
      ['FAILED', 'PENDING'],
      ['CANCELLED', 'AUTHORIZED'],
    ];

    it.each(invalidPairs)('rejects transition from %s to %s', (from, to) => {
      expect(PaymentStateMachine.canTransition(from, to)).toBe(false);
      expect(() => PaymentStateMachine.assertValidTransition(from, to)).toThrow(
        InvalidStateTransitionError
      );
    });
  });

  describe('Terminal State Checks', () => {
    it('identifies terminal states correctly', () => {
      expect(PaymentStateMachine.isTerminal('FAILED')).toBe(true);
      expect(PaymentStateMachine.isTerminal('CANCELLED')).toBe(true);
      expect(PaymentStateMachine.isTerminal('REFUNDED')).toBe(true);
      expect(PaymentStateMachine.isTerminal('SETTLED')).toBe(true);

      expect(PaymentStateMachine.isTerminal('CREATED')).toBe(false);
      expect(PaymentStateMachine.isTerminal('PENDING')).toBe(false);
      expect(PaymentStateMachine.isTerminal('AUTHORIZED')).toBe(false);
      expect(PaymentStateMachine.isTerminal('CAPTURED')).toBe(false);
    });

    it('returns empty next allowed states for terminal statuses', () => {
      expect(PaymentStateMachine.getNextAllowedStates('SETTLED')).toEqual([]);
      expect(PaymentStateMachine.getNextAllowedStates('FAILED')).toEqual([]);
    });
  });
});
