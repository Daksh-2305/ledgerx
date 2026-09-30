import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ReconciliationService } from './reconciliation.service.js';
import { ValidationError } from '../../common/errors.js';
import { reconciliationMetrics } from './reconciliation.metrics.js';
import type {
  ReconciliationRecordEntity,
  ReconciliationRunEntity,
  ReconciliationResult,
  DiscrepancyStatus,
} from './reconciliation.types.js';

const createRunSchema = z.object({
  provider: z.string().optional().default('mockpay'),
  period_start: z.string().optional(),
  periodStart: z.string().optional(),
  period_end: z.string().optional(),
  periodEnd: z.string().optional(),
});

const resolveDiscrepancySchema = z.object({
  resolved_by: z.string().optional(),
  resolvedBy: z.string().optional(),
  resolution_notes: z.string().optional(),
  resolutionNotes: z.string().optional(),
});

const generateTestDatasetSchema = z.object({
  provider: z.string().optional().default('mockpay'),
  matched_count: z.number().int().min(0).optional(),
  matchedCount: z.number().int().min(0).optional(),
  amount_mismatch_count: z.number().int().min(0).optional(),
  amountMismatchCount: z.number().int().min(0).optional(),
  status_mismatch_count: z.number().int().min(0).optional(),
  statusMismatchCount: z.number().int().min(0).optional(),
  currency_mismatch_count: z.number().int().min(0).optional(),
  currencyMismatchCount: z.number().int().min(0).optional(),
  missing_internal_count: z.number().int().min(0).optional(),
  missingInternalCount: z.number().int().min(0).optional(),
  missing_external_count: z.number().int().min(0).optional(),
  missingExternalCount: z.number().int().min(0).optional(),
  duplicate_count: z.number().int().min(0).optional(),
  duplicateCount: z.number().int().min(0).optional(),
});

function serializeRecord(record: ReconciliationRecordEntity) {
  return {
    id: record.id,
    run_id: record.runId,
    runId: record.runId,
    internal_reference: record.internalReference,
    internalReference: record.internalReference,
    external_reference: record.externalReference,
    externalReference: record.externalReference,
    internal_transaction_id: record.internalTransactionId,
    internalTransactionId: record.internalTransactionId,
    external_transaction_id: record.externalTransactionId,
    externalTransactionId: record.externalTransactionId,
    external_db_record_id: record.externalDbRecordId,
    result: record.result,
    difference_minor: Number(record.differenceMinor),
    differenceMinor: Number(record.differenceMinor),
    reason: record.reason,
    status: record.status,
    resolved_by: record.resolvedBy,
    resolvedBy: record.resolvedBy,
    resolved_at: record.resolvedAt ? record.resolvedAt.toISOString() : null,
    resolvedAt: record.resolvedAt ? record.resolvedAt.toISOString() : null,
    resolution_notes: record.resolutionNotes,
    resolutionNotes: record.resolutionNotes,
    internal_amount_minor: record.internalAmountMinor !== null && record.internalAmountMinor !== undefined ? Number(record.internalAmountMinor) : null,
    internalAmountMinor: record.internalAmountMinor !== null && record.internalAmountMinor !== undefined ? Number(record.internalAmountMinor) : null,
    external_amount_minor: record.externalAmountMinor !== null && record.externalAmountMinor !== undefined ? Number(record.externalAmountMinor) : null,
    externalAmountMinor: record.externalAmountMinor !== null && record.externalAmountMinor !== undefined ? Number(record.externalAmountMinor) : null,
    created_at: record.createdAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

function serializeRun(run: ReconciliationRunEntity) {
  const totalRecords = run.totalInternalRecords + run.totalExternalRecords;
  return {
    id: run.id,
    run_id: run.id,
    runId: run.id,
    run_reference: run.runReference,
    runReference: run.runReference,
    provider: run.provider,
    status: run.status,
    period_start: run.periodStart.toISOString(),
    periodStart: run.periodStart.toISOString(),
    period_end: run.periodEnd.toISOString(),
    periodEnd: run.periodEnd.toISOString(),
    total_records: totalRecords,
    totalRecords,
    total_internal_records: run.totalInternalRecords,
    totalInternalRecords: run.totalInternalRecords,
    total_external_records: run.totalExternalRecords,
    totalExternalRecords: run.totalExternalRecords,
    matched: run.matchedCount,
    matched_count: run.matchedCount,
    matchedCount: run.matchedCount,
    mismatched: run.mismatchCount,
    mismatch_count: run.mismatchCount,
    mismatchCount: run.mismatchCount,
    missing: run.missingInternalCount + run.missingExternalCount,
    missing_internal_count: run.missingInternalCount,
    missingInternalCount: run.missingInternalCount,
    missing_external_count: run.missingExternalCount,
    missingExternalCount: run.missingExternalCount,
    duplicate_count: run.duplicateCount,
    duplicateCount: run.duplicateCount,
    duplicates: run.duplicateCount,
    started_at: run.startedAt ? run.startedAt.toISOString() : null,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    completed_at: run.completedAt ? run.completedAt.toISOString() : null,
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    error_message: run.errorMessage,
    errorMessage: run.errorMessage,
    created_at: run.createdAt.toISOString(),
    createdAt: run.createdAt.toISOString(),
  };
}

export class ReconciliationController {
  constructor(private service: ReconciliationService) {}

  /**
   * POST /api/v1/reconciliation/runs
   * Returns 202 Accepted.
   */
  public createRun = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = createRunSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid reconciliation run request', parsed.error.issues);
      }

      const periodStart = parsed.data.period_start || parsed.data.periodStart;
      const periodEnd = parsed.data.period_end || parsed.data.periodEnd;

      if (!periodStart || !periodEnd) {
        throw new ValidationError('Both period_start and period_end are required');
      }

      const run = await this.service.createRun({
        provider: parsed.data.provider,
        periodStart,
        periodEnd,
        correlationId: (req as any).correlationId,
      });

      res.status(202).json({
        status: 'success',
        success: true,
        message: 'Reconciliation run initiated asynchronously',
        data: serializeRun(run),
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/reconciliation/runs/:runId/execute
   * Synchronous / manual trigger of run execution.
   */
  public executeRun = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runId = req.params.runId as string;
      const summary = await this.service.executeRun(runId, (req as any).correlationId);
      res.status(200).json({
        status: 'success',
        success: true,
        data: summary,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/reconciliation/runs/:runId
   */
  public getRun = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runId = req.params.runId as string;
      const run = await this.service.getRun(runId);
      res.status(200).json({
        status: 'success',
        success: true,
        data: serializeRun(run),
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/reconciliation/runs/:runId/summary
   */
  public getRunSummary = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runId = req.params.runId as string;
      const summary = await this.service.getRunSummary(runId);
      res.status(200).json({
        status: 'success',
        success: true,
        data: summary,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/reconciliation/runs
   */
  public listRuns = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { provider, status, page, limit } = req.query;
      const result = await this.service.listRuns({
        provider: typeof provider === 'string' ? provider : undefined,
        status: typeof status === 'string' ? (status as any) : undefined,
        page: page ? parseInt(page as string, 10) : 1,
        limit: limit ? parseInt(limit as string, 10) : 50,
      });

      res.status(200).json({
        status: 'success',
        success: true,
        data: result.items.map(serializeRun),
        pagination: {
          total: result.total,
          page: page ? parseInt(page as string, 10) : 1,
          limit: limit ? parseInt(limit as string, 10) : 50,
          totalPages: Math.ceil(result.total / (limit ? parseInt(limit as string, 10) : 50)) || 1,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/reconciliation/runs/:runId/records
   */
  public getRecords = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runId = req.params.runId as string;
      const { result, status, search, page, limit } = req.query;

      const pageNum = page ? parseInt(page as string, 10) : 1;
      const limitNum = limit ? parseInt(limit as string, 10) : 50;

      const response = await this.service.getRecords({
        runId,
        result: typeof result === 'string' ? (result as ReconciliationResult) : undefined,
        status: typeof status === 'string' ? (status as DiscrepancyStatus) : undefined,
        search: typeof search === 'string' ? search : undefined,
        page: pageNum,
        limit: limitNum,
      });

      res.status(200).json({
        status: 'success',
        success: true,
        data: response.items.map(serializeRecord),
        pagination: {
          total: response.total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(response.total / limitNum) || 1,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/reconciliation/records/:id
   */
  public getRecord = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const record = await this.service.getRecord(id);
      res.status(200).json({
        status: 'success',
        success: true,
        data: serializeRecord(record),
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/reconciliation/records/:id/investigate
   */
  public investigate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const actor = req.body?.actor || (req as any).user?.email || 'admin_user';
      const notes = req.body?.notes || req.body?.resolution_notes;

      const updated = await this.service.investigateDiscrepancy(
        id,
        actor,
        notes,
        (req as any).correlationId
      );

      res.status(200).json({
        status: 'success',
        success: true,
        message: 'Discrepancy transitioned to INVESTIGATING',
        data: serializeRecord(updated),
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/reconciliation/records/:id/resolve
   */
  public resolve = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const parsed = resolveDiscrepancySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid resolve request', parsed.error.issues);
      }

      const actor = parsed.data.resolved_by || parsed.data.resolvedBy || (req as any).user?.email || 'admin_user';
      const notes = parsed.data.resolution_notes || parsed.data.resolutionNotes;

      if (!notes) {
        throw new ValidationError('resolution_notes is required to resolve a discrepancy');
      }

      const updated = await this.service.resolveDiscrepancy(
        id,
        actor,
        notes,
        (req as any).correlationId
      );

      res.status(200).json({
        status: 'success',
        success: true,
        message: 'Discrepancy successfully resolved',
        data: serializeRecord(updated),
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/reconciliation/records/:id/waive
   */
  public waive = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const parsed = resolveDiscrepancySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid waive request', parsed.error.issues);
      }

      const actor = parsed.data.resolved_by || parsed.data.resolvedBy || (req as any).user?.email || 'admin_user';
      const notes = parsed.data.resolution_notes || parsed.data.resolutionNotes;

      if (!notes) {
        throw new ValidationError('resolution_notes justification is required to waive a discrepancy');
      }

      const updated = await this.service.waiveDiscrepancy(
        id,
        actor,
        notes,
        (req as any).correlationId
      );

      res.status(200).json({
        status: 'success',
        success: true,
        message: 'Discrepancy successfully waived',
        data: serializeRecord(updated),
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/reconciliation/external-records
   */
  public importExternalRecords = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const records = Array.isArray(req.body) ? req.body : req.body?.records;
      if (!records || !Array.isArray(records)) {
        throw new ValidationError('Expected an array of external records');
      }

      const result = await this.service.importExternalRecords(records);
      res.status(201).json({
        status: 'success',
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/reconciliation/generate-test-dataset
   */
  public generateTestDataset = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = generateTestDatasetSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid test dataset parameters', parsed.error.issues);
      }

      const matchedCount = parsed.data.matched_count ?? parsed.data.matchedCount ?? 90;
      const amountMismatchCount = parsed.data.amount_mismatch_count ?? parsed.data.amountMismatchCount ?? 3;
      const statusMismatchCount = parsed.data.status_mismatch_count ?? parsed.data.statusMismatchCount ?? 2;
      const currencyMismatchCount = parsed.data.currency_mismatch_count ?? parsed.data.currencyMismatchCount ?? 0;
      const missingInternalCount = parsed.data.missing_internal_count ?? parsed.data.missingInternalCount ?? 2;
      const missingExternalCount = parsed.data.missing_external_count ?? parsed.data.missingExternalCount ?? 2;
      const duplicateCount = parsed.data.duplicate_count ?? parsed.data.duplicateCount ?? 1;

      const dataset = await this.service.generateTestDataset({
        provider: parsed.data.provider,
        matchedCount,
        amountMismatchCount,
        statusMismatchCount,
        currencyMismatchCount,
        missingInternalCount,
        missingExternalCount,
        duplicateCount,
      });

      res.status(201).json({
        status: 'success',
        success: true,
        data: {
          provider: dataset.provider,
          internal_count: dataset.internalCount,
          external_count: dataset.externalCount,
          period_start: dataset.periodStart.toISOString(),
          period_end: dataset.periodEnd.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/reconciliation/dashboard
   */
  public getDashboard = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const summary = await this.service.getDashboardMetrics();
      res.status(200).json({
        status: 'success',
        success: true,
        data: summary,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/reconciliation/metrics
   */
  public getMetrics = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const metrics = reconciliationMetrics.getMetrics();
      res.status(200).json({
        status: 'success',
        success: true,
        data: metrics,
      });
    } catch (err) {
      next(err);
    }
  };
}
