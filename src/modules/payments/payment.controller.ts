import { Request, Response, NextFunction } from 'express';
import { PaymentService } from './payment.service.js';
import {
  createPaymentSchema,
  paymentIdParamSchema,
  listPaymentsQuerySchema,
  refundPaymentSchema,
  refundIdParamSchema,
  listRefundsQuerySchema,
} from './payment.validation.js';
import { ValidationError } from '../../common/errors.js';

export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  public create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = createPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid payment creation payload', parsed.error.issues);
      }

      const idempotencyKey =
        (req.headers['idempotency-key'] as string) || parsed.data.idempotency_key;

      const result = await this.paymentService.createPayment(
        {
          ...parsed.data,
          idempotency_key: idempotencyKey,
        },
        {
          actorId: (req.headers['x-actor-id'] as string) || 'merchant-api',
          correlationId: req.correlationId,
          requestId: req.requestId,
        }
      );

      res.status(201).json({
        success: true,
        data: result,
        meta: {
          correlationId: req.correlationId,
          requestId: req.requestId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  public getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsedParams = paymentIdParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
        throw new ValidationError('Invalid payment ID parameter', parsedParams.error.issues);
      }

      const payment = await this.paymentService.getPaymentById(parsedParams.data.id);

      res.status(200).json({
        success: true,
        data: payment,
        meta: {
          correlationId: req.correlationId,
          requestId: req.requestId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  public list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsedQuery = listPaymentsQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        throw new ValidationError('Invalid query parameters', parsedQuery.error.issues);
      }

      const { payments, total, page, limit, totalPages } = await this.paymentService.listPayments({
        merchantId: parsedQuery.data.merchant_id,
        status: parsedQuery.data.status,
        fromDate: parsedQuery.data.fromDate ? new Date(parsedQuery.data.fromDate) : undefined,
        toDate: parsedQuery.data.toDate ? new Date(parsedQuery.data.toDate) : undefined,
        page: parsedQuery.data.page,
        limit: parsedQuery.data.limit,
      });

      res.status(200).json({
        success: true,
        data: payments,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
        meta: {
          correlationId: req.correlationId,
          requestId: req.requestId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  public initiate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = this.validateIdParam(req.params);
      const payment = await this.paymentService.initiatePayment(id, {
        actorId: (req.headers['x-actor-id'] as string) || 'merchant-api',
        correlationId: req.correlationId,
        requestId: req.requestId,
      });

      res.status(200).json({
        success: true,
        data: payment,
        meta: { correlationId: req.correlationId, requestId: req.requestId },
      });
    } catch (err) {
      next(err);
    }
  };

  public authorize = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = this.validateIdParam(req.params);
      const payment = await this.paymentService.authorizePayment(id, {
        actorId: (req.headers['x-actor-id'] as string) || 'merchant-api',
        correlationId: req.correlationId,
        requestId: req.requestId,
      });

      res.status(200).json({
        success: true,
        data: payment,
        meta: { correlationId: req.correlationId, requestId: req.requestId },
      });
    } catch (err) {
      next(err);
    }
  };

  public capture = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = this.validateIdParam(req.params);
      const payment = await this.paymentService.capturePayment(id, {
        actorId: (req.headers['x-actor-id'] as string) || 'merchant-api',
        correlationId: req.correlationId,
        requestId: req.requestId,
      });

      res.status(200).json({
        success: true,
        data: payment,
        meta: { correlationId: req.correlationId, requestId: req.requestId },
      });
    } catch (err) {
      next(err);
    }
  };

  public cancel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = this.validateIdParam(req.params);
      const payment = await this.paymentService.cancelPayment(id, {
        actorId: (req.headers['x-actor-id'] as string) || 'merchant-api',
        correlationId: req.correlationId,
        requestId: req.requestId,
      });

      res.status(200).json({
        success: true,
        data: payment,
        meta: { correlationId: req.correlationId, requestId: req.requestId },
      });
    } catch (err) {
      next(err);
    }
  };

  public fail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = this.validateIdParam(req.params);
      const payment = await this.paymentService.failPayment(id, {
        actorId: (req.headers['x-actor-id'] as string) || 'merchant-api',
        correlationId: req.correlationId,
        requestId: req.requestId,
      });

      res.status(200).json({
        success: true,
        data: payment,
        meta: { correlationId: req.correlationId, requestId: req.requestId },
      });
    } catch (err) {
      next(err);
    }
  };

  public settle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = this.validateIdParam(req.params);
      const payment = await this.paymentService.settlePayment(id, {
        actorId: (req.headers['x-actor-id'] as string) || 'settlement-worker',
        correlationId: req.correlationId,
        requestId: req.requestId,
      });

      res.status(200).json({
        success: true,
        data: payment,
        meta: { correlationId: req.correlationId, requestId: req.requestId },
      });
    } catch (err) {
      next(err);
    }
  };

  public refund = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = this.validateIdParam(req.params);
      const parsed = refundPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid refund request payload', parsed.error.issues);
      }

      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

      const refund = await this.paymentService.refundPayment(
        id,
        parsed.data.amount_minor,
        parsed.data.reason,
        idempotencyKey,
        {
          actorId: (req.headers['x-actor-id'] as string) || 'merchant-api',
          correlationId: req.correlationId,
          requestId: req.requestId,
        }
      );

      res.status(201).json({
        success: true,
        data: refund,
        meta: {
          correlationId: req.correlationId,
          requestId: req.requestId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  public listRefunds = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = this.validateIdParam(req.params);
      const parsedQuery = listRefundsQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        throw new ValidationError('Invalid query parameters', parsedQuery.error.issues);
      }

      const { refunds, total, page, limit, totalPages } = await this.paymentService.listPaymentRefunds(
        id,
        parsedQuery.data.page,
        parsedQuery.data.limit
      );

      res.status(200).json({
        success: true,
        data: refunds,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
        meta: {
          correlationId: req.correlationId,
          requestId: req.requestId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  public getRefundById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = refundIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new ValidationError('Invalid refund ID parameter', parsed.error.issues);
      }

      const refund = await this.paymentService.getRefundById(parsed.data.id);

      res.status(200).json({
        success: true,
        data: refund,
        meta: {
          correlationId: req.correlationId,
          requestId: req.requestId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  private validateIdParam(params: unknown): { id: string } {
    const parsed = paymentIdParamSchema.safeParse(params);
    if (!parsed.success) {
      throw new ValidationError('Invalid payment ID parameter', parsed.error.issues);
    }
    return parsed.data;
  }
}
