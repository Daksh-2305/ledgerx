import { Request, Response, NextFunction } from 'express';
import { LedgerService } from './ledger.service.js';
import { z } from 'zod';
import { ValidationError } from '../../common/errors.js';
import { TransactionType } from './ledger.types.js';

const accountIdParamSchema = z.object({
  id: z.string().uuid({ message: 'Account ID must be a valid UUID' }),
});

const transactionIdParamSchema = z.object({
  id: z.string().uuid({ message: 'Transaction ID must be a valid UUID' }),
});

const listTransactionsQuerySchema = z.object({
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  transactionType: z
    .enum(['PAYMENT', 'CAPTURE', 'REFUND', 'SETTLEMENT', 'ADJUSTMENT'])
    .optional(),
  currency: z.string().length(3).optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const listAccountEntriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  public getAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = accountIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new ValidationError('Invalid account ID parameter', parsed.error.issues);
      }

      const balance = await this.ledgerService.getAccountWithBalance(parsed.data.id);

      res.status(200).json({
        success: true,
        data: {
          ...balance,
          totalDebitsMinor: Number(balance.totalDebitsMinor),
          totalCreditsMinor: Number(balance.totalCreditsMinor),
          netBalanceMinor: Number(balance.netBalanceMinor),
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

  public getAccountEntries = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsedParams = accountIdParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
        throw new ValidationError('Invalid account ID parameter', parsedParams.error.issues);
      }
      const parsedQuery = listAccountEntriesQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        throw new ValidationError('Invalid query parameters', parsedQuery.error.issues);
      }

      const result = await this.ledgerService.listAccountEntries(
        parsedParams.data.id,
        parsedQuery.data.page,
        parsedQuery.data.limit
      );

      res.status(200).json({
        success: true,
        data: result.entries.map((e) => ({
          ...e,
          amountMinor: Number(e.amountMinor),
          createdAt: e.createdAt.toISOString(),
        })),
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages,
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

  public getTransaction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = transactionIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new ValidationError('Invalid transaction ID parameter', parsed.error.issues);
      }

      const tx = await this.ledgerService.getTransactionById(parsed.data.id);

      res.status(200).json({
        success: true,
        data: {
          ...tx,
          postedAt: tx.postedAt.toISOString(),
          createdAt: tx.createdAt.toISOString(),
          entries: tx.entries.map((e) => ({
            ...e,
            amountMinor: Number(e.amountMinor),
            createdAt: e.createdAt.toISOString(),
          })),
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

  public listTransactions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = listTransactionsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('Invalid query parameters', parsed.error.issues);
      }

      const result = await this.ledgerService.listTransactions({
        referenceType: parsed.data.referenceType,
        referenceId: parsed.data.referenceId,
        transactionType: parsed.data.transactionType as TransactionType | undefined,
        currency: parsed.data.currency,
        fromDate: parsed.data.fromDate ? new Date(parsed.data.fromDate) : undefined,
        toDate: parsed.data.toDate ? new Date(parsed.data.toDate) : undefined,
        page: parsed.data.page,
        limit: parsed.data.limit,
      });

      res.status(200).json({
        success: true,
        data: result.transactions.map((tx) => ({
          ...tx,
          postedAt: tx.postedAt.toISOString(),
          createdAt: tx.createdAt.toISOString(),
          entries: tx.entries.map((e) => ({
            ...e,
            amountMinor: Number(e.amountMinor),
            createdAt: e.createdAt.toISOString(),
          })),
        })),
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages,
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

  public checkIntegrity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const report = await this.ledgerService.verifyLedgerIntegrity();

      res.status(200).json({
        success: true,
        data: report,
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
}
