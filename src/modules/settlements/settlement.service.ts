import crypto from 'node:crypto';
import {
  SettlementBatchStatus,
  SettlementRecordStatus,
  SettlementBatchEntity,
  SettlementRecordEntity,
  CreateSettlementBatchInput,
  SettlementFilter,
  SettlementRecordFilter,
  SettlementReportSummary,
} from './settlement.types.js';
import { ISettlementRepository } from './settlement.repository.js';
import { SettlementCalculator } from './settlement.calculator.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { KafkaProducerService } from '../../infra/kafka/kafka-producer.js';
import {
  EventTypes,
  KafkaTopics,
  createEventEnvelope,
} from '../../infra/kafka/event-envelope.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors.js';
import { formatMinorToMajor, SUPPORTED_CURRENCIES } from '../../common/money.js';
import { logger } from '../../common/logger.js';
import { config } from '../../config/index.js';
import { RedisCacheService } from '../../infra/redis/redis-cache.service.js';

export interface RequestContext {
  actorId?: string;
  correlationId?: string;
  requestId?: string;
}

export class SettlementService {
  constructor(
    private readonly repository: ISettlementRepository,
    private readonly ledgerService?: LedgerService,
    private readonly kafkaProducer?: KafkaProducerService,
    protected readonly cacheService?: RedisCacheService
  ) {}

  /**
   * Allowed state transitions for SettlementBatch
   */
  private static readonly ALLOWED_TRANSITIONS: Record<SettlementBatchStatus, SettlementBatchStatus[]> = {
    [SettlementBatchStatus.PENDING]: [
      SettlementBatchStatus.PROCESSING,
      SettlementBatchStatus.CANCELLED,
      SettlementBatchStatus.FAILED,
    ],
    [SettlementBatchStatus.PROCESSING]: [
      SettlementBatchStatus.RECONCILED,
      SettlementBatchStatus.FAILED,
    ],
    [SettlementBatchStatus.RECONCILED]: [
      SettlementBatchStatus.READY,
      SettlementBatchStatus.FAILED,
    ],
    [SettlementBatchStatus.READY]: [
      SettlementBatchStatus.PROCESSING_SETTLEMENT,
      SettlementBatchStatus.CANCELLED,
      SettlementBatchStatus.FAILED,
    ],
    [SettlementBatchStatus.PROCESSING_SETTLEMENT]: [
      SettlementBatchStatus.SETTLED,
      SettlementBatchStatus.FAILED,
    ],
    [SettlementBatchStatus.SETTLED]: [], // Terminal
    [SettlementBatchStatus.FAILED]: [
      SettlementBatchStatus.PROCESSING, // Allow retry from failed state
    ],
    [SettlementBatchStatus.CANCELLED]: [], // Terminal
  };

  private static readonly inFlightCreations = new Map<string, Promise<SettlementBatchEntity>>();

  /**
   * Creates a new settlement batch request.
   * Enforces idempotency on [merchantId, currency, periodStart, periodEnd].
   */
  public async createSettlementBatch(
    input: CreateSettlementBatchInput,
    context: RequestContext = {}
  ): Promise<SettlementBatchEntity> {
    const currency = input.currency.toUpperCase();
    if (!SUPPORTED_CURRENCIES[currency]) {
      throw new ValidationError(`Unsupported currency: ${input.currency}`);
    }

    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);

    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
      throw new ValidationError('Invalid settlement period dates');
    }
    if (periodStart.getTime() > periodEnd.getTime()) {
      throw new ValidationError('Period start date must precede period end date');
    }

    const lockKey = `${input.merchantId}:${currency}:${periodStart.getTime()}:${periodEnd.getTime()}`;
    const inFlight = SettlementService.inFlightCreations.get(lockKey);
    if (inFlight) {
      return inFlight;
    }

    const task = this.doCreateSettlementBatch(input, currency, periodStart, periodEnd, context);
    SettlementService.inFlightCreations.set(lockKey, task);

    try {
      return await task;
    } finally {
      SettlementService.inFlightCreations.delete(lockKey);
    }
  }

  private async doCreateSettlementBatch(
    input: CreateSettlementBatchInput,
    currency: string,
    periodStart: Date,
    periodEnd: Date,
    context: RequestContext = {}
  ): Promise<SettlementBatchEntity> {

    // 1. Idempotency Check: if identical batch exists, return existing
    const existing = await this.repository.findBatchByMerchantAndPeriod(
      input.merchantId,
      currency,
      periodStart,
      periodEnd
    );

    if (existing) {
      logger.info(
        `Settlement batch for merchant ${input.merchantId} [${periodStart.toISOString()} - ${periodEnd.toISOString()}] already exists. Returning idempotently.`,
        {
          correlationId: context.correlationId,
          batchId: existing.id,
          status: existing.status,
        }
      );
      return existing;
    }

    const batchId = crypto.randomUUID();
    const batchReference = `SETTLE-${input.merchantId.slice(0, 8).toUpperCase()}-${Date.now()}`;
    const now = new Date();

    const newBatch: SettlementBatchEntity = {
      id: batchId,
      batchReference,
      merchantId: input.merchantId,
      currency,
      periodStart,
      periodEnd,
      grossAmountMinor: 0n,
      refundAmountMinor: 0n,
      adjustmentAmountMinor: BigInt(input.adjustmentAmountMinor || 0),
      feeAmountMinor: 0n,
      netAmountMinor: 0n,
      status: SettlementBatchStatus.PENDING,
      recordCount: 0,
      ledgerTransactionId: null,
      errorMessage: null,
      createdAt: now,
      processingStartedAt: null,
      completedAt: null,
      updatedAt: now,
    };

    let createdBatch: SettlementBatchEntity;
    try {
      createdBatch = await this.repository.createBatch(newBatch);
    } catch (err: any) {
      if (err instanceof ConflictError || err?.code === 'P2002') {
        const raceExisting = await this.repository.findBatchByMerchantAndPeriod(
          input.merchantId,
          currency,
          periodStart,
          periodEnd
        );
        if (raceExisting) {
          logger.info(
            `Concurrent settlement batch race resolved for merchant ${input.merchantId}. Returning existing batch ${raceExisting.id}.`,
            { correlationId: context.correlationId, batchId: raceExisting.id }
          );
          return raceExisting;
        }
      }
      throw err;
    }

    // 2. Publish Domain Event
    if (this.kafkaProducer) {
      const event = createEventEnvelope({
        eventType: EventTypes.SETTLEMENT_BATCH_CREATED,
        aggregateType: 'SettlementBatch',
        aggregateId: createdBatch.id,
        payload: {
          batch_id: createdBatch.id,
          batch_reference: createdBatch.batchReference,
          merchant_id: createdBatch.merchantId,
          currency: createdBatch.currency,
          period_start: createdBatch.periodStart.toISOString(),
          period_end: createdBatch.periodEnd.toISOString(),
          fee_bps: input.feeBps ?? config.SETTLEMENT_DEFAULT_FEE_BPS,
        },
        correlationId: context.correlationId,
      });
      await this.kafkaProducer.publishEvent(event, KafkaTopics.SETTLEMENT_EVENTS);
    }

    logger.info(`Settlement batch created: ${createdBatch.id}`, {
      correlationId: context.correlationId,
      batchId: createdBatch.id,
      merchantId: createdBatch.merchantId,
      reference: createdBatch.batchReference,
    });

    return createdBatch;
  }

  /**
   * State Machine Transition Guard
   */
  public async transitionStatus(
    batchId: string,
    newStatus: SettlementBatchStatus,
    updates: Partial<SettlementBatchEntity> = {},
    context: RequestContext = {}
  ): Promise<SettlementBatchEntity> {
    const batch = await this.repository.findBatchById(batchId);
    if (!batch) {
      throw new NotFoundError('SettlementBatch', batchId);
    }

    const allowed = SettlementService.ALLOWED_TRANSITIONS[batch.status] || [];
    if (!allowed.includes(newStatus)) {
      throw new ConflictError(
        `Invalid settlement batch transition from '${batch.status}' to '${newStatus}'`
      );
    }

    const updated = await this.repository.updateBatch(batchId, {
      ...updates,
      status: newStatus,
      updatedAt: new Date(),
    });

    logger.info(`Settlement batch ${batchId} transitioned: ${batch.status} -> ${newStatus}`, {
      correlationId: context.correlationId,
      batchId,
      fromStatus: batch.status,
      toStatus: newStatus,
    });

    return updated;
  }

  /**
   * Executes the full batch calculation, reconciliation verification, invariant check, and marks READY.
   * Invoked by Kafka consumer or asynchronous worker.
   */
  public async processBatch(
    batchId: string,
    options: { feeBps?: number; adjustmentAmountMinor?: bigint } = {},
    context: RequestContext = {}
  ): Promise<SettlementBatchEntity> {
    const batch = await this.repository.findBatchById(batchId);
    if (!batch) {
      throw new NotFoundError('SettlementBatch', batchId);
    }

    // If already READY or SETTLED, idempotent return
    if (
      batch.status === SettlementBatchStatus.READY ||
      batch.status === SettlementBatchStatus.SETTLED ||
      batch.status === SettlementBatchStatus.PROCESSING_SETTLEMENT
    ) {
      logger.info(`Batch ${batchId} is already in status ${batch.status}. Returning idempotently.`);
      return batch;
    }

    // 1. Transition: PENDING -> PROCESSING
    const processingBatch = await this.transitionStatus(
      batchId,
      SettlementBatchStatus.PROCESSING,
      { processingStartedAt: new Date(), errorMessage: null },
      context
    );

    try {
      // 2. Load payments for merchant & currency within period
      const payments = await this.repository.findEligiblePaymentsForPeriod(
        processingBatch.merchantId,
        processingBatch.currency,
        processingBatch.periodStart,
        processingBatch.periodEnd
      );

      const itemsToCalculate = [];

      for (const payment of payments) {
        // Eligibility rule A: Not already settled in another batch
        const alreadySettled = await this.repository.findExistingSettledRecordForPayment(payment.id);
        if (alreadySettled && alreadySettled.batchId !== batchId) {
          itemsToCalculate.push({
            paymentId: payment.id,
            merchantId: payment.merchantId,
            currency: payment.currency,
            capturedAmountMinor: payment.capturedAmountMinor,
            refundedAmountMinor: payment.refundedAmountMinor,
            isEligible: false,
            exclusionReason: 'Payment is already included in another active or settled batch',
            ledgerTransactionId: null,
          });
          continue;
        }

        // Eligibility rule B: M9 Reconciliation Integration
        // If there's an unresolved critical discrepancy, exclude payment from settlement!
        const unresolvedDiscrepancy = await this.repository.findUnresolvedDiscrepancyForPayment(
          payment.id
        );
        if (unresolvedDiscrepancy) {
          itemsToCalculate.push({
            paymentId: payment.id,
            merchantId: payment.merchantId,
            currency: payment.currency,
            capturedAmountMinor: payment.capturedAmountMinor,
            refundedAmountMinor: payment.refundedAmountMinor,
            isEligible: false,
            exclusionReason: `Unresolved reconciliation discrepancy: ${unresolvedDiscrepancy.discrepancyType} (${unresolvedDiscrepancy.status})`,
            ledgerTransactionId: null,
          });
          continue;
        }

        // Payment is eligible
        itemsToCalculate.push({
          paymentId: payment.id,
          merchantId: payment.merchantId,
          currency: payment.currency,
          capturedAmountMinor: payment.capturedAmountMinor,
          refundedAmountMinor: payment.refundedAmountMinor,
          isEligible: true,
          ledgerTransactionId: null,
        });
      }

      // 3. Calculate batch financial figures with invariant verification
      const feeBps = options.feeBps ?? config.SETTLEMENT_DEFAULT_FEE_BPS;
      const calcResult = SettlementCalculator.calculateBatch(itemsToCalculate, {
        feeBps,
        adjustmentAmountMinor: options.adjustmentAmountMinor ?? processingBatch.adjustmentAmountMinor,
      });

      // 4. Persist individual SettlementRecords
      const recordsToCreate: SettlementRecordEntity[] = calcResult.items.map((item) => ({
        id: crypto.randomUUID(),
        batchId,
        paymentId: item.paymentId,
        ledgerTransactionId: item.ledgerTransactionId || null,
        merchantId: item.merchantId,
        grossAmountMinor: item.capturedAmountMinor,
        refundAmountMinor: item.refundedAmountMinor,
        feeAmountMinor: item.feeAmountMinor,
        netAmountMinor: item.netAmountMinor,
        currency: item.currency,
        status: item.isEligible ? SettlementRecordStatus.INCLUDED : SettlementRecordStatus.EXCLUDED,
        errorMessage: item.exclusionReason || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      await this.repository.createRecordsBatch(recordsToCreate);

      // 5. Transition: PROCESSING -> RECONCILED
      await this.transitionStatus(
        batchId,
        SettlementBatchStatus.RECONCILED,
        {
          grossAmountMinor: calcResult.grossAmountMinor,
          refundAmountMinor: calcResult.refundAmountMinor,
          feeAmountMinor: calcResult.feeAmountMinor,
          adjustmentAmountMinor: calcResult.adjustmentAmountMinor,
          netAmountMinor: calcResult.netAmountMinor,
          recordCount: calcResult.recordCount,
        },
        context
      );

      // 6. Transition: RECONCILED -> READY
      const readyBatch = await this.transitionStatus(
        batchId,
        SettlementBatchStatus.READY,
        {},
        context
      );

      if (this.kafkaProducer) {
        const event = createEventEnvelope({
          eventType: EventTypes.SETTLEMENT_READY,
          aggregateType: 'SettlementBatch',
          aggregateId: batchId,
          payload: {
            batch_id: batchId,
            merchant_id: readyBatch.merchantId,
            gross_amount_minor: Number(readyBatch.grossAmountMinor),
            net_amount_minor: Number(readyBatch.netAmountMinor),
            record_count: readyBatch.recordCount,
          },
          correlationId: context.correlationId,
        });
        await this.kafkaProducer.publishEvent(event, KafkaTopics.SETTLEMENT_EVENTS);
      }

      return readyBatch;
    } catch (err: any) {
      logger.error(`Settlement processing failed for batch ${batchId}: ${err.message}`, {
        correlationId: context.correlationId,
        error: err.message,
        stack: err.stack,
      });

      await this.transitionStatus(
        batchId,
        SettlementBatchStatus.FAILED,
        { errorMessage: err.message },
        context
      );

      throw err;
    }
  }

  /**
   * Executes settlement payout and posts balanced double-entry ledger entries.
   */
  public async executeSettlement(
    batchId: string,
    context: RequestContext = {}
  ): Promise<SettlementBatchEntity> {
    const batch = await this.repository.findBatchById(batchId);
    if (!batch) {
      throw new NotFoundError('SettlementBatch', batchId);
    }

    if (batch.status === SettlementBatchStatus.SETTLED) {
      logger.info(`Batch ${batchId} is already SETTLED. Returning idempotently.`);
      return batch;
    }

    if (batch.status !== SettlementBatchStatus.READY) {
      throw new ConflictError(
        `Cannot execute settlement for batch ${batchId}. Batch must be in 'READY' status, currently '${batch.status}'`
      );
    }

    // 1. Transition: READY -> PROCESSING_SETTLEMENT
    await this.transitionStatus(
      batchId,
      SettlementBatchStatus.PROCESSING_SETTLEMENT,
      {},
      context
    );

    try {
      let ledgerTransactionId: string | null = null;

      // 2. Post balanced ledger transaction via LedgerService
      if (this.ledgerService && batch.netAmountMinor > 0n) {
        const ledgerTx = await this.ledgerService.recordSettlement(
          {
            id: batch.id,
            batchReference: batch.batchReference,
            merchantId: batch.merchantId,
            netAmountMinor: batch.netAmountMinor,
            currency: batch.currency,
          },
          context
        );
        if (ledgerTx) {
          ledgerTransactionId = ledgerTx.id;
        }
      }

      // 3. Mark all included records as SETTLED
      await this.repository.updateRecordsStatusByBatch(batchId, SettlementRecordStatus.SETTLED);

      // 4. Transition: PROCESSING_SETTLEMENT -> SETTLED
      const settledBatch = await this.transitionStatus(
        batchId,
        SettlementBatchStatus.SETTLED,
        {
          ledgerTransactionId,
          completedAt: new Date(),
        },
        context
      );

      if (this.kafkaProducer) {
        const event = createEventEnvelope({
          eventType: EventTypes.SETTLEMENT_COMPLETED,
          aggregateType: 'SettlementBatch',
          aggregateId: batchId,
          payload: {
            batch_id: batchId,
            merchant_id: settledBatch.merchantId,
            net_amount_minor: Number(settledBatch.netAmountMinor),
            ledger_transaction_id: ledgerTransactionId,
          },
          correlationId: context.correlationId,
        });
        await this.kafkaProducer.publishEvent(event, KafkaTopics.SETTLEMENT_EVENTS);
      }

      return settledBatch;
    } catch (err: any) {
      logger.error(`Settlement execution failed for batch ${batchId}: ${err.message}`, {
        correlationId: context.correlationId,
        error: err.message,
      });

      await this.transitionStatus(
        batchId,
        SettlementBatchStatus.FAILED,
        { errorMessage: err.message },
        context
      );

      throw err;
    }
  }

  /**
   * Cancels a settlement batch if in safe state (PENDING or READY).
   */
  public async cancelBatch(
    batchId: string,
    reason: string = 'Cancelled by operator',
    context: RequestContext = {}
  ): Promise<SettlementBatchEntity> {
    return this.transitionStatus(
      batchId,
      SettlementBatchStatus.CANCELLED,
      { errorMessage: reason },
      context
    );
  }

  public async getBatchById(id: string): Promise<SettlementBatchEntity> {
    const batch = await this.repository.findBatchById(id);
    if (!batch) {
      throw new NotFoundError('SettlementBatch', id);
    }
    return batch;
  }

  public async listBatches(
    filter: SettlementFilter
  ): Promise<{ batches: SettlementBatchEntity[]; total: number }> {
    return this.repository.findBatches(filter);
  }

  public async listBatchRecords(
    filter: SettlementRecordFilter
  ): Promise<{ records: SettlementRecordEntity[]; total: number }> {
    return this.repository.findRecordsByBatchId(filter);
  }

  /**
   * Generates a comprehensive settlement report summary.
   */
  public async getSettlementReport(id: string): Promise<SettlementReportSummary> {
    const batch = await this.getBatchById(id);

    return {
      batchId: batch.id,
      batchReference: batch.batchReference,
      merchantId: batch.merchantId,
      currency: batch.currency,
      period: {
        start: batch.periodStart.toISOString(),
        end: batch.periodEnd.toISOString(),
      },
      amounts: {
        grossMinor: Number(batch.grossAmountMinor),
        refundMinor: Number(batch.refundAmountMinor),
        feeMinor: Number(batch.feeAmountMinor),
        adjustmentMinor: Number(batch.adjustmentAmountMinor),
        netMinor: Number(batch.netAmountMinor),
        grossFormatted: formatMinorToMajor(batch.grossAmountMinor, batch.currency),
        refundFormatted: formatMinorToMajor(batch.refundAmountMinor, batch.currency),
        feeFormatted: formatMinorToMajor(batch.feeAmountMinor, batch.currency),
        adjustmentFormatted: formatMinorToMajor(batch.adjustmentAmountMinor, batch.currency),
        netFormatted: formatMinorToMajor(batch.netAmountMinor, batch.currency),
      },
      recordCount: batch.recordCount,
      status: batch.status,
      ledgerTransactionId: batch.ledgerTransactionId || null,
      processingStartedAt: batch.processingStartedAt?.toISOString() || null,
      completedAt: batch.completedAt?.toISOString() || null,
      createdAt: batch.createdAt.toISOString(),
    };
  }
}
