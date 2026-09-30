import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentService } from './payment.service.js';
import { InMemoryPaymentRepository } from './payment.repository.js';
import {
  ValidationError,
  NotFoundError,
  FinancialInvarianceError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../common/errors.js';

describe('PaymentService', () => {
  let repository: InMemoryPaymentRepository;
  let service: PaymentService;

  const merchantA = {
    id: '11111111-1111-1111-1111-111111111111',
    businessName: 'Merchant Alpha',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const merchantB = {
    id: '22222222-2222-2222-2222-222222222222',
    businessName: 'Merchant Beta',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const customerA = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    merchantId: merchantA.id,
    name: 'Customer Alpha',
    email: 'alpha@example.com',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const customerB = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    merchantId: merchantB.id,
    name: 'Customer Beta',
    email: 'beta@example.com',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    repository = new InMemoryPaymentRepository();
    await repository.saveMerchant(merchantA);
    await repository.saveMerchant(merchantB);
    await repository.saveCustomer(customerA);
    await repository.saveCustomer(customerB);
    service = new PaymentService(repository);
  });

  describe('Payment Creation Validations', () => {
    it('creates a valid payment successfully in CREATED state', async () => {
      const payment = await service.createPayment({
        merchant_id: merchantA.id,
        customer_id: customerA.id,
        amount_minor: 10000, // ₹100.00
        currency: 'INR',
        description: 'Test payment',
      });

      expect(payment.id).toBeDefined();
      expect(payment.status).toBe('CREATED');
      expect(payment.amount_minor).toBe(10000);
      expect(payment.currency).toBe('INR');
      expect(payment.merchant_id).toBe(merchantA.id);
      expect(payment.customer_id).toBe(customerA.id);
    });

    it('rejects payment with zero or negative amount', async () => {
      await expect(
        service.createPayment({
          merchant_id: merchantA.id,
          customer_id: customerA.id,
          amount_minor: 0,
          currency: 'INR',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createPayment({
          merchant_id: merchantA.id,
          customer_id: customerA.id,
          amount_minor: -500,
          currency: 'INR',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects payment with non-existent merchant', async () => {
      await expect(
        service.createPayment({
          merchant_id: '99999999-9999-9999-9999-999999999999',
          customer_id: customerA.id,
          amount_minor: 1000,
          currency: 'INR',
        })
      ).rejects.toThrow(NotFoundError);
    });

    it('rejects payment with non-existent customer', async () => {
      await expect(
        service.createPayment({
          merchant_id: merchantA.id,
          customer_id: '99999999-9999-9999-9999-999999999999',
          amount_minor: 1000,
          currency: 'INR',
        })
      ).rejects.toThrow(NotFoundError);
    });

    it('rejects payment when customer does not belong to the merchant', async () => {
      // customerB belongs to merchantB, trying to pay under merchantA
      await expect(
        service.createPayment({
          merchant_id: merchantA.id,
          customer_id: customerB.id,
          amount_minor: 5000,
          currency: 'INR',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects payment with unsupported currency', async () => {
      await expect(
        service.createPayment({
          merchant_id: merchantA.id,
          customer_id: customerA.id,
          amount_minor: 5000,
          currency: 'XYZ',
        })
      ).rejects.toThrow(FinancialInvarianceError);
    });
  });

  describe('Full State Transition Lifecycle', () => {
    it('progresses through CREATED -> PENDING -> AUTHORIZED -> CAPTURED -> SETTLED', async () => {
      const created = await service.createPayment({
        merchant_id: merchantA.id,
        customer_id: customerA.id,
        amount_minor: 25000,
        currency: 'USD',
      });
      expect(created.status).toBe('CREATED');

      const pending = await service.initiatePayment(created.id);
      expect(pending.status).toBe('PENDING');

      const authorized = await service.authorizePayment(created.id);
      expect(authorized.status).toBe('AUTHORIZED');

      const captured = await service.capturePayment(created.id);
      expect(captured.status).toBe('CAPTURED');
      expect(captured.captured_amount_minor).toBe(25000);

      const settled = await service.settlePayment(created.id);
      expect(settled.status).toBe('SETTLED');
    });

    it('allows cancellation from PENDING and AUTHORIZED', async () => {
      const p1 = await service.createPayment({
        merchant_id: merchantA.id,
        customer_id: customerA.id,
        amount_minor: 1000,
        currency: 'INR',
      });
      await service.initiatePayment(p1.id);
      const cancelledFromPending = await service.cancelPayment(p1.id);
      expect(cancelledFromPending.status).toBe('CANCELLED');

      const p2 = await service.createPayment({
        merchant_id: merchantA.id,
        customer_id: customerA.id,
        amount_minor: 2000,
        currency: 'INR',
      });
      await service.initiatePayment(p2.id);
      await service.authorizePayment(p2.id);
      const cancelledFromAuthorized = await service.cancelPayment(p2.id);
      expect(cancelledFromAuthorized.status).toBe('CANCELLED');
    });
  });

  describe('Concurrency & Race Condition Protection', () => {
    it('protects against simultaneous duplicate capture requests: one succeeds and one fails', async () => {
      // Setup a payment ready for capture (in AUTHORIZED state)
      const payment = await service.createPayment({
        merchant_id: merchantA.id,
        customer_id: customerA.id,
        amount_minor: 50000,
        currency: 'EUR',
      });
      await service.initiatePayment(payment.id);
      await service.authorizePayment(payment.id);

      // Fire two simultaneous capture requests for the exact same payment
      const [res1, res2] = await Promise.allSettled([
        service.capturePayment(payment.id, { actorId: 'client-thread-1' }),
        service.capturePayment(payment.id, { actorId: 'client-thread-2' }),
      ]);

      const successes = [res1, res2].filter((r) => r.status === 'fulfilled');
      const failures = [res1, res2].filter((r) => r.status === 'rejected');

      // Invariant: Exactly one must succeed, exactly one must fail
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);

      // Verify the failure was due to state conflict
      const rejectedReason = (failures[0] as PromiseRejectedResult).reason;
      expect(
        rejectedReason instanceof ConflictError ||
          rejectedReason instanceof InvalidStateTransitionError
      ).toBe(true);

      // Final payment state in database must be strictly CAPTURED
      const finalPayment = await service.getPaymentById(payment.id);
      expect(finalPayment.status).toBe('CAPTURED');
      expect(finalPayment.captured_amount_minor).toBe(50000);

      // Audit logs must record exactly one capture transition
      const captureAudits = finalPayment.audit_logs.filter(
        (log) =>
          log.action === 'STATE_TRANSITION' &&
          log.changes &&
          (log.changes as { newStatus?: string }).newStatus === 'CAPTURED'
      );
      expect(captureAudits.length).toBe(1);
    });
  });
});
