import { z } from 'zod';

export const createPaymentSchema = z.object({
  merchant_id: z.string().uuid({ message: 'merchant_id must be a valid UUID' }),
  customer_id: z.string().uuid({ message: 'customer_id must be a valid UUID' }),
  amount_minor: z
    .number({ required_error: 'amount_minor is required' })
    .int({ message: 'amount_minor must be an integer' })
    .positive({ message: 'amount_minor must be strictly positive (> 0)' }),
  currency: z
    .string({ required_error: 'currency is required' })
    .length(3, { message: 'currency must be a 3-letter ISO code' })
    .transform((val) => val.toUpperCase()),
  description: z.string().max(1000).optional(),
  idempotency_key: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const paymentIdParamSchema = z.object({
  id: z.string().uuid({ message: 'Payment ID must be a valid UUID' }),
});

export const listPaymentsQuerySchema = z.object({
  merchant_id: z.string().uuid().optional(),
  status: z
    .enum([
      'CREATED',
      'PENDING',
      'AUTHORIZED',
      'CAPTURED',
      'FAILED',
      'CANCELLED',
      'REFUND_PENDING',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
      'SETTLED',
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  fromDate: z
    .string()
    .datetime({ message: 'fromDate must be a valid ISO datetime' })
    .optional(),
  toDate: z
    .string()
    .datetime({ message: 'toDate must be a valid ISO datetime' })
    .optional(),
});

export const refundPaymentSchema = z.object({
  amount_minor: z
    .number({ required_error: 'amount_minor is required' })
    .int({ message: 'amount_minor must be an integer' })
    .positive({ message: 'amount_minor must be strictly positive (> 0)' }),
  reason: z.string().max(500).optional(),
});

export const refundIdParamSchema = z.object({
  id: z.string().uuid({ message: 'Refund ID must be a valid UUID' }),
});

export const listRefundsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type ListPaymentsQueryInput = z.infer<typeof listPaymentsQuerySchema>;
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;
