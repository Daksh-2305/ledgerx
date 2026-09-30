import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { SettlementService } from './settlement.service.js';
import { SettlementBatchEntity, SettlementRecordEntity } from './settlement.types.js';
import { formatMinorToMajor } from '../../common/money.js';

const createBatchSchema = z.object({
  merchant_id: z.string().optional(),
  merchantId: z.string().optional(),
  currency: z.string().min(3).max(3),
  period_start: z.string().optional(),
  periodStart: z.string().optional(),
  period_end: z.string().optional(),
  periodEnd: z.string().optional(),
  fee_bps: z.number().int().min(0).max(10000).optional(),
  feeBps: z.number().int().min(0).max(10000).optional(),
  adjustment_amount_minor: z.coerce.number().int().optional(),
  adjustmentAmountMinor: z.coerce.number().int().optional(),
});

function serializeBatch(batch: SettlementBatchEntity) {
  return {
    id: batch.id,
    batch_reference: batch.batchReference,
    batchReference: batch.batchReference,
    merchant_id: batch.merchantId,
    merchantId: batch.merchantId,
    currency: batch.currency,
    period_start: batch.periodStart.toISOString(),
    periodStart: batch.periodStart.toISOString(),
    period_end: batch.periodEnd.toISOString(),
    periodEnd: batch.periodEnd.toISOString(),
    gross_amount_minor: Number(batch.grossAmountMinor),
    grossAmountMinor: Number(batch.grossAmountMinor),
    refund_amount_minor: Number(batch.refundAmountMinor),
    refundAmountMinor: Number(batch.refundAmountMinor),
    adjustment_amount_minor: Number(batch.adjustmentAmountMinor),
    adjustmentAmountMinor: Number(batch.adjustmentAmountMinor),
    fee_amount_minor: Number(batch.feeAmountMinor),
    feeAmountMinor: Number(batch.feeAmountMinor),
    net_amount_minor: Number(batch.netAmountMinor),
    netAmountMinor: Number(batch.netAmountMinor),
    gross_formatted: formatMinorToMajor(batch.grossAmountMinor, batch.currency),
    refund_formatted: formatMinorToMajor(batch.refundAmountMinor, batch.currency),
    fee_formatted: formatMinorToMajor(batch.feeAmountMinor, batch.currency),
    adjustment_formatted: formatMinorToMajor(batch.adjustmentAmountMinor, batch.currency),
    net_formatted: formatMinorToMajor(batch.netAmountMinor, batch.currency),
    status: batch.status,
    record_count: batch.recordCount,
    recordCount: batch.recordCount,
    ledger_transaction_id: batch.ledgerTransactionId || null,
    ledgerTransactionId: batch.ledgerTransactionId || null,
    error_message: batch.errorMessage || null,
    errorMessage: batch.errorMessage || null,
    processing_started_at: batch.processingStartedAt?.toISOString() || null,
    processingStartedAt: batch.processingStartedAt?.toISOString() || null,
    completed_at: batch.completedAt?.toISOString() || null,
    completedAt: batch.completedAt?.toISOString() || null,
    created_at: batch.createdAt.toISOString(),
    createdAt: batch.createdAt.toISOString(),
  };
}

function serializeRecord(record: SettlementRecordEntity) {
  return {
    id: record.id,
    batch_id: record.batchId,
    batchId: record.batchId,
    payment_id: record.paymentId,
    paymentId: record.paymentId,
    merchant_id: record.merchantId,
    merchantId: record.merchantId,
    currency: record.currency,
    gross_amount_minor: Number(record.grossAmountMinor),
    grossAmountMinor: Number(record.grossAmountMinor),
    refund_amount_minor: Number(record.refundAmountMinor),
    refundAmountMinor: Number(record.refundAmountMinor),
    fee_amount_minor: Number(record.feeAmountMinor),
    feeAmountMinor: Number(record.feeAmountMinor),
    net_amount_minor: Number(record.netAmountMinor),
    netAmountMinor: Number(record.netAmountMinor),
    gross_formatted: formatMinorToMajor(record.grossAmountMinor, record.currency),
    refund_formatted: formatMinorToMajor(record.refundAmountMinor, record.currency),
    fee_formatted: formatMinorToMajor(record.feeAmountMinor, record.currency),
    net_formatted: formatMinorToMajor(record.netAmountMinor, record.currency),
    status: record.status,
    ledger_transaction_id: record.ledgerTransactionId || null,
    ledgerTransactionId: record.ledgerTransactionId || null,
    error_message: record.errorMessage || null,
    errorMessage: record.errorMessage || null,
    created_at: record.createdAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

export class SettlementController {
  constructor(private readonly service: SettlementService) {}

  public createBatch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = createBatchSchema.parse(req.body);
      const merchantId = parsed.merchant_id || parsed.merchantId;
      const periodStart = parsed.period_start || parsed.periodStart;
      const periodEnd = parsed.period_end || parsed.periodEnd;
      const feeBps = parsed.fee_bps ?? parsed.feeBps;
      const adjustmentAmountMinor = parsed.adjustment_amount_minor ?? parsed.adjustmentAmountMinor;

      if (!merchantId) {
        res.status(400).json({ error: 'merchant_id is required' });
        return;
      }
      if (!periodStart || !periodEnd) {
        res.status(400).json({ error: 'period_start and period_end are required' });
        return;
      }

      const batch = await this.service.createSettlementBatch(
        {
          merchantId,
          currency: parsed.currency,
          periodStart,
          periodEnd,
          feeBps,
          adjustmentAmountMinor,
        },
        {
          correlationId: req.headers['x-correlation-id'] as string,
          requestId: req.headers['x-request-id'] as string,
        }
      );

      // Return 202 Accepted for asynchronous processing
      res.status(202).json({
        message: 'Settlement batch accepted for processing',
        batch: serializeBatch(batch),
      });
    } catch (err) {
      next(err);
    }
  };

  public listBatches = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const {
        merchant_id,
        merchantId,
        currency,
        status,
        from_date,
        fromDate,
        to_date,
        toDate,
        page,
        limit,
      } = req.query;

      const pageNum = page ? parseInt(page as string, 10) : 1;
      const limitNum = limit ? parseInt(limit as string, 10) : 20;

      const result = await this.service.listBatches({
        merchantId: (merchant_id as string) || (merchantId as string),
        currency: currency as string,
        status: status as any,
        fromDate: (from_date as string) || (fromDate as string),
        toDate: (to_date as string) || (toDate as string),
        page: pageNum,
        limit: limitNum,
      });

      res.status(200).json({
        data: result.batches.map(serializeBatch),
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: result.total,
          total_pages: Math.ceil(result.total / limitNum),
          totalPages: Math.ceil(result.total / limitNum),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  public getBatchById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const batch = await this.service.getBatchById(id);
      res.status(200).json({ data: serializeBatch(batch) });
    } catch (err) {
      next(err);
    }
  };

  public getBatchRecords = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const { status, page, limit } = req.query;

      const pageNum = page ? parseInt(page as string, 10) : 1;
      const limitNum = limit ? parseInt(limit as string, 10) : 50;

      const result = await this.service.listBatchRecords({
        batchId: id,
        status: status as any,
        page: pageNum,
        limit: limitNum,
      });

      res.status(200).json({
        data: result.records.map(serializeRecord),
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: result.total,
          total_pages: Math.ceil(result.total / limitNum),
          totalPages: Math.ceil(result.total / limitNum),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  public getSettlementReport = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const id = req.params.id as string;
      const report = await this.service.getSettlementReport(id);
      res.status(200).json({ data: report });
    } catch (err) {
      next(err);
    }
  };

  public processBatch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const feeBps = req.body.fee_bps ?? req.body.feeBps;
      const adjustment = req.body.adjustment_amount_minor ?? req.body.adjustmentAmountMinor;

      const batch = await this.service.processBatch(
        id,
        {
          feeBps,
          adjustmentAmountMinor: adjustment ? BigInt(adjustment) : undefined,
        },
        {
          correlationId: req.headers['x-correlation-id'] as string,
          requestId: req.headers['x-request-id'] as string,
        }
      );

      res.status(200).json({
        message: 'Batch processing completed',
        data: serializeBatch(batch),
      });
    } catch (err) {
      next(err);
    }
  };

  public executeSettlement = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const id = req.params.id as string;
      const batch = await this.service.executeSettlement(id, {
        correlationId: req.headers['x-correlation-id'] as string,
        requestId: req.headers['x-request-id'] as string,
      });

      res.status(200).json({
        message: 'Settlement executed and ledger posted',
        data: serializeBatch(batch),
      });
    } catch (err) {
      next(err);
    }
  };

  public cancelBatch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const reason = req.body.reason || 'Cancelled by operator';
      const batch = await this.service.cancelBatch(id, reason, {
        correlationId: req.headers['x-correlation-id'] as string,
      });

      res.status(200).json({
        message: 'Batch cancelled successfully',
        data: serializeBatch(batch),
      });
    } catch (err) {
      next(err);
    }
  };
}
