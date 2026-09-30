import { PaymentItem, PaymentLifecycleEvent, PaymentStatus } from '../types/index.js';

export class PaymentTimelineBuilder {
  /**
   * Generates a deterministic visual lifecycle timeline based on actual payment data.
   * Never invents timestamps; only assigns timestamps that exist in authoritative records.
   */
  public static buildTimeline(
    payment: PaymentItem,
    additionalEvents: Array<{ status: string; timestamp: string }> = []
  ): PaymentLifecycleEvent[] {
    const eventsByStatus = new Map<string, string>();
    for (const ev of additionalEvents) {
      eventsByStatus.set(ev.status.toUpperCase(), ev.timestamp);
    }

    const createdAt = payment.createdAt;
    const updatedAt = payment.updatedAt;

    if (payment.status === 'FAILED') {
      return [
        {
          step: 'Created',
          timestamp: createdAt,
          status: 'completed',
          description: 'Payment order created in LedgerX',
        },
        {
          step: 'Pending',
          timestamp: eventsByStatus.get('PENDING') || createdAt,
          status: 'completed',
          description: 'Payment processing initiated with provider',
        },
        {
          step: 'Failed',
          timestamp: eventsByStatus.get('FAILED') || updatedAt,
          status: 'failed',
          description: 'Payment authorization or capture failed',
        },
      ];
    }

    if (payment.status === 'CANCELLED') {
      return [
        {
          step: 'Created',
          timestamp: createdAt,
          status: 'completed',
          description: 'Payment order created in LedgerX',
        },
        {
          step: 'Failed',
          timestamp: eventsByStatus.get('CANCELLED') || updatedAt,
          status: 'failed',
          description: 'Payment was cancelled before completion',
        },
      ];
    }

    const standardSteps: Array<{
      step: 'Created' | 'Pending' | 'Authorized' | 'Captured' | 'Settled';
      matchingStatus: PaymentStatus[];
      description: string;
    }> = [
      {
        step: 'Created',
        matchingStatus: ['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'SETTLED'],
        description: 'Payment initialized',
      },
      {
        step: 'Pending',
        matchingStatus: ['PENDING', 'AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'SETTLED'],
        description: 'Gateway processing initiated',
      },
      {
        step: 'Authorized',
        matchingStatus: ['AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'SETTLED'],
        description: 'Funds authorized by bank',
      },
      {
        step: 'Captured',
        matchingStatus: ['CAPTURED', 'PARTIALLY_REFUNDED', 'SETTLED'],
        description: 'Funds captured & double-entry ledger posted',
      },
      {
        step: 'Settled',
        matchingStatus: ['SETTLED'],
        description: 'Settled to merchant account in settlement batch',
      },
    ];

    const currentStatusHierarchy: Record<string, number> = {
      CREATED: 0,
      PENDING: 1,
      AUTHORIZED: 2,
      CAPTURED: 3,
      PARTIALLY_REFUNDED: 3,
      REFUND_PENDING: 3,
      REFUNDED: 3,
      SETTLED: 4,
    };

    const currentLevel = currentStatusHierarchy[payment.status] ?? 0;

    return standardSteps.map((stepDef, idx) => {
      let status: 'completed' | 'current' | 'upcoming';
      let timestamp: string | undefined;

      if (idx < currentLevel) {
        status = 'completed';
        timestamp = eventsByStatus.get(stepDef.step.toUpperCase()) || (idx === 0 ? createdAt : undefined);
      } else if (idx === currentLevel) {
        status = 'current';
        timestamp = eventsByStatus.get(stepDef.step.toUpperCase()) || updatedAt;
      } else {
        status = 'upcoming';
        timestamp = undefined;
      }

      return {
        step: stepDef.step,
        timestamp,
        status,
        description: stepDef.description,
      };
    });
  }
}
