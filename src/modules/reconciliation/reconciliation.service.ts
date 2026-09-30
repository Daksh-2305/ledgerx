import crypto from 'node:crypto';
import { logger } from '../../common/logger.js';
import {
  NotFoundError,
  ValidationError,
  InvalidStateTransitionError,
} from '../../common/errors.js';
import { config } from '../../config/index.js';
import { KafkaProducerService } from '../../infra/kafka/kafka-producer.js';
import {
  createEventEnvelope,
  DomainEventTypes,
  KafkaTopics,
} from '../../infra/kafka/event-envelope.js';
import type { IReconciliationRepository } from './reconciliation.repository.js';
import { ReconciliationMatcher } from './reconciliation-matcher.js';
import { reconciliationMetrics } from './reconciliation.metrics.js';
import type {
  CreateReconciliationRunDTO,
  ReconciliationRunEntity,
  ReconciliationRecordEntity,
  ReconciliationSummary,
  ReconciliationRecordFilter,
  CreateExternalRecordDTO,
  GenerateTestDatasetOptions,
  ExternalTransactionEntity,
  InternalRecordSummary,
} from './reconciliation.types.js';

export class ReconciliationService {
  constructor(
    private repository: IReconciliationRepository,
    private matcher: ReconciliationMatcher = new ReconciliationMatcher(),
    private kafkaProducer?: KafkaProducerService
  ) {}

  /**
   * Creates a new reconciliation run and dispatches an asynchronous execution event.
   * Returns immediately (HTTP 202 Accepted semantics).
   */
  public async createRun(dto: CreateReconciliationRunDTO): Promise<ReconciliationRunEntity> {
    const provider = (dto.provider || config.RECONCILIATION_DEFAULT_PROVIDER || 'mockpay').toLowerCase().trim();
    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);
    const correlationId = dto.correlationId || `recon_corr_${crypto.randomBytes(4).toString('hex')}`;

    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
      throw new ValidationError('Invalid periodStart or periodEnd date string');
    }

    if (periodStart >= periodEnd) {
      throw new ValidationError('periodStart must be strictly earlier than periodEnd');
    }

    // Idempotency check: verify if an active or pending run with the exact same provider & window already exists
    const existingRuns = await this.repository.listRuns({ provider, page: 1, limit: 10 });
    const duplicateRun = existingRuns.items.find(
      (r) =>
        (r.status === 'PENDING' || r.status === 'RUNNING') &&
        r.periodStart.getTime() === periodStart.getTime() &&
        r.periodEnd.getTime() === periodEnd.getTime()
    );

    if (duplicateRun) {
      logger.info('Reconciliation run already exists and in progress. Returning existing run.', {
        runId: duplicateRun.id,
        runReference: duplicateRun.runReference,
        provider,
        correlationId,
      });
      return duplicateRun;
    }

    const runReference = `REC-${provider.toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const run = await this.repository.createRun({
      runReference,
      provider,
      periodStart,
      periodEnd,
      status: 'PENDING',
      totalInternalRecords: 0,
      totalExternalRecords: 0,
      matchedCount: 0,
      mismatchCount: 0,
      missingInternalCount: 0,
      missingExternalCount: 0,
      duplicateCount: 0,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
    });

    reconciliationMetrics.recordRunCreated();

    await this.repository.createAuditLog({
      entityType: 'reconciliation_run',
      entityId: run.id,
      action: 'reconciliation_run_created',
      actorId: 'system',
      actorType: 'SYSTEM',
      changes: {
        runReference,
        provider,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      },
      correlationId,
    });

    // Publish run created event to Kafka for asynchronous worker consumption
    if (this.kafkaProducer) {
      try {
        const envelope = createEventEnvelope({
          eventType: DomainEventTypes.RECONCILIATION_RUN_CREATED,
          aggregateType: 'reconciliation_run',
          aggregateId: run.id,
          correlationId,
          producer: 'reconciliation-service',
          payload: {
            run_id: run.id,
            run_reference: run.runReference,
            provider: run.provider,
            period_start: run.periodStart.toISOString(),
            period_end: run.periodEnd.toISOString(),
          },
        });

        await this.kafkaProducer.publishEvent(envelope, KafkaTopics.RECONCILIATION_EVENTS);
        logger.info('Published reconciliation.run.created event to Kafka', {
          runId: run.id,
          topic: KafkaTopics.RECONCILIATION_EVENTS,
        });
      } catch (err) {
        logger.warn('Failed to publish reconciliation.run.created event directly; worker can poll', {
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return run;
  }

  /**
   * Executes the reconciliation matching deterministically.
   * Designed to be invoked by the Kafka worker or synchronously in unit tests.
   */
  public async executeRun(runId: string, correlationId?: string): Promise<ReconciliationSummary> {
    const run = await this.repository.getRunById(runId);
    if (!run) {
      throw new NotFoundError(`Reconciliation run ${runId} not found`);
    }

    // Idempotency: If run is already COMPLETED, avoid re-running and return current summary
    if (run.status === 'COMPLETED') {
      logger.info('Reconciliation run already completed. Returning cached summary.', { runId });
      return this.getRunSummary(runId);
    }

    const corrId = correlationId || `recon_exec_${crypto.randomBytes(4).toString('hex')}`;
    const startTime = Date.now();

    // Mark run as RUNNING
    await this.repository.updateRun(runId, {
      status: 'RUNNING',
      startedAt: new Date(),
    });

    await this.repository.createAuditLog({
      entityType: 'reconciliation_run',
      entityId: runId,
      action: 'reconciliation_started',
      actorId: 'reconciliation-worker',
      actorType: 'WORKER',
      correlationId: corrId,
    });

    try {
      // 1. Fetch internal records for the provider/period
      const internalRecords = await this.repository.listInternalRecords({
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
      });

      // 2. Fetch external records for the provider/period
      const externalRecords = await this.repository.listExternalTransactions({
        provider: run.provider,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
      });

      logger.info('Starting reconciliation matching', {
        runId,
        provider: run.provider,
        internalCount: internalRecords.length,
        externalCount: externalRecords.length,
      });

      // 3. Perform O(N + M) deterministic matching
      const matchResult = this.matcher.match(runId, internalRecords, externalRecords);

      // 4. Batch-persist reconciliation records in Discrepancy DB
      await this.repository.saveRecordsBatch(matchResult.records);

      // 5. Update run status and summary counts derived directly from records
      await this.repository.updateRun(runId, {
        status: 'COMPLETED',
        totalInternalRecords: matchResult.totalInternal,
        totalExternalRecords: matchResult.totalExternal,
        matchedCount: matchResult.matchedCount,
        mismatchCount: matchResult.mismatchCount,
        missingInternalCount: matchResult.missingInternalCount,
        missingExternalCount: matchResult.missingExternalCount,
        duplicateCount: matchResult.duplicateCount,
        completedAt: new Date(),
      });

      const durationMs = Date.now() - startTime;

      // Update metrics
      reconciliationMetrics.recordRunSuccess(durationMs);
      reconciliationMetrics.recordProcessedCounts({
        processed: matchResult.records.length,
        matched: matchResult.matchedCount,
        mismatched: matchResult.mismatchCount,
        missingInternal: matchResult.missingInternalCount,
        missingExternal: matchResult.missingExternalCount,
        duplicates: matchResult.duplicateCount,
      });

      // Audit log
      await this.repository.createAuditLog({
        entityType: 'reconciliation_run',
        entityId: runId,
        action: 'reconciliation_completed',
        actorId: 'reconciliation-worker',
        actorType: 'WORKER',
        changes: {
          matchedCount: matchResult.matchedCount,
          mismatchCount: matchResult.mismatchCount,
          missingInternalCount: matchResult.missingInternalCount,
          missingExternalCount: matchResult.missingExternalCount,
          duplicateCount: matchResult.duplicateCount,
          durationMs,
        },
        correlationId: corrId,
      });

      // Emit Kafka event
      if (this.kafkaProducer) {
        try {
          const envelope = createEventEnvelope({
            eventType: DomainEventTypes.RECONCILIATION_RUN_COMPLETED,
            aggregateType: 'reconciliation_run',
            aggregateId: runId,
            correlationId: corrId,
            producer: 'reconciliation-service',
            payload: {
              run_id: runId,
              matched_count: matchResult.matchedCount,
              mismatch_count: matchResult.mismatchCount,
              missing_internal: matchResult.missingInternalCount,
              missing_external: matchResult.missingExternalCount,
              duplicates: matchResult.duplicateCount,
              duration_ms: durationMs,
            },
          });
          await this.kafkaProducer.publishEvent(envelope, KafkaTopics.RECONCILIATION_EVENTS);
        } catch (eventErr) {
          logger.warn('Failed to publish reconciliation.run.completed event', { error: String(eventErr) });
        }
      }

      logger.info('Reconciliation run completed successfully', {
        runId,
        durationMs,
        matched: matchResult.matchedCount,
        mismatches: matchResult.mismatchCount,
      });

      return this.getRunSummary(runId);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      await this.repository.updateRun(runId, {
        status: 'FAILED',
        errorMessage: errorMsg,
        completedAt: new Date(),
      });

      reconciliationMetrics.recordRunFailed(durationMs);

      await this.repository.createAuditLog({
        entityType: 'reconciliation_run',
        entityId: runId,
        action: 'reconciliation_run_failed',
        actorId: 'reconciliation-worker',
        actorType: 'WORKER',
        changes: { errorMessage: errorMsg, durationMs },
        correlationId: corrId,
      });

      if (this.kafkaProducer) {
        try {
          const envelope = createEventEnvelope({
            eventType: DomainEventTypes.RECONCILIATION_RUN_FAILED,
            aggregateType: 'reconciliation_run',
            aggregateId: runId,
            correlationId: corrId,
            producer: 'reconciliation-service',
            payload: {
              run_id: runId,
              error_message: errorMsg,
            },
          });
          await this.kafkaProducer.publishEvent(envelope, KafkaTopics.RECONCILIATION_EVENTS);
        } catch {
          // ignore
        }
      }

      logger.error('Reconciliation run failed', { runId, error: errorMsg });
      throw err;
    }
  }

  /**
   * Retrieves summary statistics for a reconciliation run.
   */
  public async getRunSummary(runId: string): Promise<ReconciliationSummary> {
    const run = await this.repository.getRunById(runId);
    if (!run) {
      throw new NotFoundError(`Reconciliation run ${runId} not found`);
    }

    const { items: records } = await this.repository.getRecordsByRunId({
      runId,
      limit: 100000,
    });

    let amountMismatches = 0;
    let statusMismatches = 0;
    let currencyMismatches = 0;

    for (const r of records) {
      if (r.result === 'AMOUNT_MISMATCH') amountMismatches++;
      else if (r.result === 'STATUS_MISMATCH') statusMismatches++;
      else if (r.result === 'CURRENCY_MISMATCH') currencyMismatches++;
    }

    const totalDiscrepancies =
      run.mismatchCount + run.missingInternalCount + run.missingExternalCount + run.duplicateCount;

    const totalComparable = run.totalExternalRecords > 0 ? run.totalExternalRecords : run.totalInternalRecords;
    const matchRatePercentage =
      totalComparable > 0
        ? Number(((run.matchedCount / totalComparable) * 100).toFixed(1))
        : 100;

    let durationMs: number | null = null;
    if (run.startedAt && run.completedAt) {
      durationMs = run.completedAt.getTime() - run.startedAt.getTime();
    }

    return {
      runId: run.id,
      runReference: run.runReference,
      provider: run.provider,
      status: run.status,
      periodStart: run.periodStart.toISOString(),
      periodEnd: run.periodEnd.toISOString(),
      totalInternal: run.totalInternalRecords,
      totalExternal: run.totalExternalRecords,
      matched: run.matchedCount,
      amountMismatches,
      statusMismatches,
      currencyMismatches,
      missingInternal: run.missingInternalCount,
      missingExternal: run.missingExternalCount,
      duplicates: run.duplicateCount,
      totalDiscrepancies,
      matchRatePercentage,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
      durationMs,
    };
  }

  public async getRun(runId: string): Promise<ReconciliationRunEntity> {
    const run = await this.repository.getRunById(runId);
    if (!run) {
      throw new NotFoundError(`Reconciliation run ${runId} not found`);
    }
    return run;
  }

  public async listRuns(options?: {
    provider?: string;
    status?: any;
    page?: number;
    limit?: number;
  }): Promise<{ items: ReconciliationRunEntity[]; total: number }> {
    return this.repository.listRuns(options);
  }

  public async getRecords(filter: ReconciliationRecordFilter): Promise<{ items: ReconciliationRecordEntity[]; total: number }> {
    return this.repository.getRecordsByRunId(filter);
  }

  public async getRecord(recordId: string): Promise<ReconciliationRecordEntity> {
    const record = await this.repository.getRecordById(recordId);
    if (!record) {
      throw new NotFoundError(`Reconciliation record ${recordId} not found`);
    }
    return record;
  }

  // ==========================================
  // DISCREPANCY LIFECYCLE MANAGEMENT
  // OPEN -> INVESTIGATING -> RESOLVED
  // OPEN or INVESTIGATING -> WAIVED
  // ==========================================

  /**
   * Transition discrepancy from OPEN -> INVESTIGATING.
   */
  public async investigateDiscrepancy(
    recordId: string,
    actor: string,
    notes?: string,
    correlationId?: string
  ): Promise<ReconciliationRecordEntity> {
    const record = await this.repository.getRecordById(recordId);
    if (!record) throw new NotFoundError(`Reconciliation record ${recordId} not found`);

    if (record.status !== 'OPEN') {
      throw new InvalidStateTransitionError(record.status, 'INVESTIGATING', 'Only OPEN discrepancies can enter investigation');
    }

    const updated = await this.repository.updateRecordStatus(
      recordId,
      'INVESTIGATING',
      actor,
      notes || `Investigation commenced by ${actor}`
    );

    await this.repository.createAuditLog({
      entityType: 'reconciliation_record',
      entityId: recordId,
      action: 'discrepancy_investigated',
      actorId: actor,
      actorType: 'USER',
      changes: {
        fromStatus: 'OPEN',
        toStatus: 'INVESTIGATING',
        notes,
      },
      correlationId,
    });

    return updated;
  }

  /**
   * Transition discrepancy from OPEN or INVESTIGATING -> RESOLVED.
   * Critical guarantee: Financial records are NOT altered.
   */
  public async resolveDiscrepancy(
    recordId: string,
    actor: string,
    resolutionNotes: string,
    correlationId?: string
  ): Promise<ReconciliationRecordEntity> {
    if (!resolutionNotes || resolutionNotes.trim().length === 0) {
      throw new ValidationError('Resolution notes are mandatory when resolving a discrepancy');
    }

    const record = await this.repository.getRecordById(recordId);
    if (!record) throw new NotFoundError(`Reconciliation record ${recordId} not found`);

    if (record.status === 'RESOLVED') {
      throw new InvalidStateTransitionError(record.status, 'RESOLVED', 'Discrepancy is already resolved');
    }

    if (record.status === 'WAIVED') {
      throw new InvalidStateTransitionError(record.status, 'RESOLVED', 'Waived discrepancies cannot be resolved');
    }

    const updated = await this.repository.updateRecordStatus(
      recordId,
      'RESOLVED',
      actor,
      resolutionNotes
    );

    await this.repository.createAuditLog({
      entityType: 'reconciliation_record',
      entityId: recordId,
      action: 'discrepancy_resolved',
      actorId: actor,
      actorType: 'USER',
      changes: {
        fromStatus: record.status,
        toStatus: 'RESOLVED',
        resolutionNotes,
      },
      correlationId,
    });

    return updated;
  }

  /**
   * Transition discrepancy from OPEN or INVESTIGATING -> WAIVED.
   */
  public async waiveDiscrepancy(
    recordId: string,
    actor: string,
    resolutionNotes: string,
    correlationId?: string
  ): Promise<ReconciliationRecordEntity> {
    if (!resolutionNotes || resolutionNotes.trim().length === 0) {
      throw new ValidationError('Waiver justification notes are mandatory');
    }

    const record = await this.repository.getRecordById(recordId);
    if (!record) throw new NotFoundError(`Reconciliation record ${recordId} not found`);

    if (record.status === 'RESOLVED' || record.status === 'WAIVED') {
      throw new InvalidStateTransitionError(record.status, 'WAIVED', 'Cannot waive already resolved or waived discrepancy');
    }

    const updated = await this.repository.updateRecordStatus(
      recordId,
      'WAIVED',
      actor,
      resolutionNotes
    );

    await this.repository.createAuditLog({
      entityType: 'reconciliation_record',
      entityId: recordId,
      action: 'discrepancy_waived',
      actorId: actor,
      actorType: 'USER',
      changes: {
        fromStatus: record.status,
        toStatus: 'WAIVED',
        resolutionNotes,
      },
      correlationId,
    });

    return updated;
  }

  // ==========================================
  // EXTERNAL DATA IMPORT & TEST SIMULATION
  // ==========================================

  /**
   * Imports raw external provider records.
   */
  public async importExternalRecords(records: CreateExternalRecordDTO[]): Promise<{ importedCount: number }> {
    if (!records || records.length === 0) {
      throw new ValidationError('External records list cannot be empty');
    }

    const entities: Omit<ExternalTransactionEntity, 'id' | 'createdAt'>[] = records.map((r) => {
      const amountMinor = typeof r.amountMinor === 'bigint' ? r.amountMinor : BigInt(r.amountMinor);
      return {
        provider: r.provider.toLowerCase().trim(),
        externalTransactionId: r.externalTransactionId,
        externalReference: r.externalReference,
        paymentReference: r.paymentReference ?? null,
        transactionType: r.transactionType || 'PAYMENT',
        amountMinor,
        currency: r.currency.toUpperCase(),
        status: r.status.toUpperCase(),
        transactionTimestamp: new Date(r.transactionTimestamp),
        settlementDate: r.settlementDate ? new Date(r.settlementDate) : null,
        rawData: r.rawData || {},
      };
    });

    const count = await this.repository.saveExternalTransactionsBatch(entities);
    return { importedCount: count };
  }

  /**
   * Generates a realistic synthetic test dataset containing controlled discrepancy counts.
   * Useful for end-to-end reconciliation testing and UI demonstrations.
   */
  public async generateTestDataset(options: GenerateTestDatasetOptions): Promise<{
    internalCount: number;
    externalCount: number;
    periodStart: Date;
    periodEnd: Date;
    provider: string;
  }> {
    const provider = (options.provider || 'mockpay').toLowerCase();
    const currency = (options.currency || 'INR').toUpperCase();
    const baseDate = options.baseDate || new Date();

    const periodStart = new Date(baseDate.getTime() - 24 * 60 * 60 * 1000);
    const periodEnd = new Date(baseDate.getTime() + 24 * 60 * 60 * 1000);

    const internalList: InternalRecordSummary[] = [];
    const externalList: Omit<ExternalTransactionEntity, 'id' | 'createdAt'>[] = [];

    let seq = 1;

    // 1. MATCHED records
    for (let i = 0; i < options.matchedCount; i++) {
      const payRef = `PAY-${seq.toString().padStart(5, '0')}`;
      const extRef = `EXT-${(9000 + seq).toString().padStart(5, '0')}`;
      const amount = BigInt(10000 + i * 50);

      internalList.push({
        id: crypto.randomUUID(),
        reference: payRef,
        idempotencyKey: payRef,
        amountMinor: amount,
        currency,
        status: 'CAPTURED',
        createdAt: new Date(baseDate.getTime() + i * 1000),
      });

      externalList.push({
        provider,
        externalTransactionId: extRef,
        externalReference: extRef,
        paymentReference: payRef,
        transactionType: 'PAYMENT',
        amountMinor: amount,
        currency,
        status: 'CAPTURED',
        transactionTimestamp: new Date(baseDate.getTime() + i * 1000),
      });

      seq++;
    }

    // 2. AMOUNT MISMATCH records
    for (let i = 0; i < options.amountMismatchCount; i++) {
      const payRef = `PAY-${seq.toString().padStart(5, '0')}`;
      const extRef = `EXT-${(9000 + seq).toString().padStart(5, '0')}`;
      const internalAmount = BigInt(20000);
      const externalAmount = BigInt(19500); // 500 minor units difference

      internalList.push({
        id: crypto.randomUUID(),
        reference: payRef,
        idempotencyKey: payRef,
        amountMinor: internalAmount,
        currency,
        status: 'CAPTURED',
        createdAt: new Date(baseDate.getTime() + seq * 1000),
      });

      externalList.push({
        provider,
        externalTransactionId: extRef,
        externalReference: extRef,
        paymentReference: payRef,
        transactionType: 'PAYMENT',
        amountMinor: externalAmount,
        currency,
        status: 'CAPTURED',
        transactionTimestamp: new Date(baseDate.getTime() + seq * 1000),
      });

      seq++;
    }

    // 3. STATUS MISMATCH records
    for (let i = 0; i < options.statusMismatchCount; i++) {
      const payRef = `PAY-${seq.toString().padStart(5, '0')}`;
      const extRef = `EXT-${(9000 + seq).toString().padStart(5, '0')}`;
      const amount = BigInt(15000);

      internalList.push({
        id: crypto.randomUUID(),
        reference: payRef,
        idempotencyKey: payRef,
        amountMinor: amount,
        currency,
        status: 'CAPTURED', // Internal is CAPTURED
        createdAt: new Date(baseDate.getTime() + seq * 1000),
      });

      externalList.push({
        provider,
        externalTransactionId: extRef,
        externalReference: extRef,
        paymentReference: payRef,
        transactionType: 'PAYMENT',
        amountMinor: amount,
        currency,
        status: 'FAILED', // External is FAILED
        transactionTimestamp: new Date(baseDate.getTime() + seq * 1000),
      });

      seq++;
    }

    // 4. CURRENCY MISMATCH records
    const currencyMismatchCount = options.currencyMismatchCount || 0;
    for (let i = 0; i < currencyMismatchCount; i++) {
      const payRef = `PAY-${seq.toString().padStart(5, '0')}`;
      const extRef = `EXT-${(9000 + seq).toString().padStart(5, '0')}`;
      const amount = BigInt(30000);

      internalList.push({
        id: crypto.randomUUID(),
        reference: payRef,
        idempotencyKey: payRef,
        amountMinor: amount,
        currency: 'INR',
        status: 'CAPTURED',
        createdAt: new Date(baseDate.getTime() + seq * 1000),
      });

      externalList.push({
        provider,
        externalTransactionId: extRef,
        externalReference: extRef,
        paymentReference: payRef,
        transactionType: 'PAYMENT',
        amountMinor: amount,
        currency: 'USD',
        status: 'CAPTURED',
        transactionTimestamp: new Date(baseDate.getTime() + seq * 1000),
      });

      seq++;
    }

    // 5. MISSING INTERNAL records (external exists, no internal)
    for (let i = 0; i < options.missingInternalCount; i++) {
      const extRef = `EXT-${(9000 + seq).toString().padStart(5, '0')}`;
      const payRef = `PAY-UNKNOWN-${seq}`;
      const amount = BigInt(5000);

      externalList.push({
        provider,
        externalTransactionId: extRef,
        externalReference: extRef,
        paymentReference: payRef,
        transactionType: 'PAYMENT',
        amountMinor: amount,
        currency,
        status: 'CAPTURED',
        transactionTimestamp: new Date(baseDate.getTime() + seq * 1000),
      });

      seq++;
    }

    // 6. MISSING EXTERNAL records (internal exists, no external)
    for (let i = 0; i < options.missingExternalCount; i++) {
      const payRef = `PAY-${seq.toString().padStart(5, '0')}`;
      const amount = BigInt(7500);

      internalList.push({
        id: crypto.randomUUID(),
        reference: payRef,
        idempotencyKey: payRef,
        amountMinor: amount,
        currency,
        status: 'CAPTURED',
        createdAt: new Date(baseDate.getTime() + seq * 1000),
      });

      seq++;
    }

    // 7. DUPLICATE EXTERNAL records
    for (let i = 0; i < options.duplicateCount; i++) {
      if (externalList.length > 0 && externalList[0]) {
        const original = externalList[0];
        externalList.push({
          provider: original.provider,
          externalTransactionId: original.externalTransactionId,
          externalReference: original.externalReference,
          paymentReference: original.paymentReference,
          transactionType: original.transactionType,
          amountMinor: original.amountMinor,
          currency: original.currency,
          status: original.status,
          transactionTimestamp: original.transactionTimestamp,
          settlementDate: original.settlementDate,
          rawData: { duplicateOf: original.externalTransactionId },
        });
      }
    }

    // Inject into repository
    if ('addInternalRecords' in this.repository) {
      (this.repository as any).addInternalRecords(internalList);
    }
    await this.repository.saveExternalTransactionsBatch(externalList);

    return {
      internalCount: internalList.length,
      externalCount: externalList.length,
      periodStart,
      periodEnd,
      provider,
    };
  }

  public async getDashboardMetrics(): Promise<any> {
    return this.repository.getDashboardSummary();
  }
}
