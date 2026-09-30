import { PrismaClient, SettlementRecordStatus } from '@prisma/client';
import { getPrismaClient } from '../../db/client.js';
import {
  SettlementBatchEntity,
  SettlementFilter,
  SettlementRecordEntity,
  SettlementRecordFilter,
} from './settlement.types.js';
import { ConflictError, NotFoundError } from '../../common/errors.js';

export interface ISettlementRepository {
  createBatch(batch: SettlementBatchEntity): Promise<SettlementBatchEntity>;
  findBatchById(id: string): Promise<SettlementBatchEntity | null>;
  findBatchByMerchantAndPeriod(
    merchantId: string,
    currency: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<SettlementBatchEntity | null>;
  findBatches(
    filter: SettlementFilter
  ): Promise<{ batches: SettlementBatchEntity[]; total: number }>;
  updateBatch(id: string, updates: Partial<SettlementBatchEntity>): Promise<SettlementBatchEntity>;
  createRecordsBatch(records: SettlementRecordEntity[]): Promise<void>;
  findRecordsByBatchId(
    filter: SettlementRecordFilter
  ): Promise<{ records: SettlementRecordEntity[]; total: number }>;
  findRecordByPaymentId(paymentId: string): Promise<SettlementRecordEntity | null>;
  findExistingSettledRecordForPayment(paymentId: string): Promise<SettlementRecordEntity | null>;
  updateRecordsStatusByBatch(batchId: string, status: SettlementRecordStatus): Promise<void>;
  findEligiblePaymentsForPeriod(
    merchantId: string,
    currency: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<Array<{
    id: string;
    merchantId: string;
    customerId: string;
    currency: string;
    status: string;
    amountMinor: bigint;
    capturedAmountMinor: bigint;
    refundedAmountMinor: bigint;
    createdAt: Date;
    updatedAt: Date;
  }>>;
  findUnresolvedDiscrepancyForPayment(paymentId: string): Promise<{
    id: string;
    runId: string;
    discrepancyType: string;
    status: string;
    amountDifferenceMinor?: bigint | null;
  } | null>;
}

export class PrismaSettlementRepository implements ISettlementRepository {
  constructor(private readonly client: PrismaClient = getPrismaClient()) {}

  public async createBatch(batch: SettlementBatchEntity): Promise<SettlementBatchEntity> {
    const created = await this.client.settlementBatch.create({
      data: {
        id: batch.id,
        batchReference: batch.batchReference,
        merchantId: batch.merchantId,
        currency: batch.currency,
        periodStart: batch.periodStart,
        periodEnd: batch.periodEnd,
        grossAmountMinor: batch.grossAmountMinor,
        refundAmountMinor: batch.refundAmountMinor,
        adjustmentAmountMinor: batch.adjustmentAmountMinor,
        feeAmountMinor: batch.feeAmountMinor,
        netAmountMinor: batch.netAmountMinor,
        status: batch.status,
        recordCount: batch.recordCount,
        ledgerTransactionId: batch.ledgerTransactionId || null,
        errorMessage: batch.errorMessage || null,
        createdAt: batch.createdAt,
        processingStartedAt: batch.processingStartedAt || null,
        completedAt: batch.completedAt || null,
      },
    });

    return created as SettlementBatchEntity;
  }

  public async findBatchById(id: string): Promise<SettlementBatchEntity | null> {
    const batch = await this.client.settlementBatch.findUnique({
      where: { id },
    });
    return (batch as SettlementBatchEntity) || null;
  }

  public async findBatchByMerchantAndPeriod(
    merchantId: string,
    currency: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<SettlementBatchEntity | null> {
    const batch = await this.client.settlementBatch.findFirst({
      where: {
        merchantId,
        currency,
        periodStart,
        periodEnd,
      },
    });
    return (batch as SettlementBatchEntity) || null;
  }

  public async findBatches(
    filter: SettlementFilter
  ): Promise<{ batches: SettlementBatchEntity[]; total: number }> {
    const where: any = {};

    if (filter.merchantId) where.merchantId = filter.merchantId;
    if (filter.currency) where.currency = filter.currency;
    if (filter.status) where.status = filter.status;
    if (filter.fromDate || filter.toDate) {
      where.createdAt = {};
      if (filter.fromDate) where.createdAt.gte = new Date(filter.fromDate);
      if (filter.toDate) where.createdAt.lte = new Date(filter.toDate);
    }

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 100) : 20;
    const skip = (page - 1) * limit;

    const [batches, total] = await Promise.all([
      this.client.settlementBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.client.settlementBatch.count({ where }),
    ]);

    return { batches: batches as SettlementBatchEntity[], total };
  }

  public async updateBatch(
    id: string,
    updates: Partial<SettlementBatchEntity>
  ): Promise<SettlementBatchEntity> {
    const updated = await this.client.settlementBatch.update({
      where: { id },
      data: updates as any,
    });
    return updated as SettlementBatchEntity;
  }

  public async createRecordsBatch(records: SettlementRecordEntity[]): Promise<void> {
    if (!records.length) return;

    await this.client.settlementRecord.createMany({
      data: records.map((r) => ({
        id: r.id,
        batchId: r.batchId,
        paymentId: r.paymentId,
        ledgerTransactionId: r.ledgerTransactionId || null,
        merchantId: r.merchantId,
        grossAmountMinor: r.grossAmountMinor,
        refundAmountMinor: r.refundAmountMinor,
        feeAmountMinor: r.feeAmountMinor,
        netAmountMinor: r.netAmountMinor,
        currency: r.currency,
        status: r.status,
        errorMessage: r.errorMessage || null,
        createdAt: r.createdAt,
      })),
    });
  }

  public async findRecordsByBatchId(
    filter: SettlementRecordFilter
  ): Promise<{ records: SettlementRecordEntity[]; total: number }> {
    const where: any = { batchId: filter.batchId };
    if (filter.status) where.status = filter.status;

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 100) : 50;
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      this.client.settlementRecord.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      this.client.settlementRecord.count({ where }),
    ]);

    return { records: records as SettlementRecordEntity[], total };
  }

  public async findRecordByPaymentId(paymentId: string): Promise<SettlementRecordEntity | null> {
    const record = await this.client.settlementRecord.findFirst({
      where: { paymentId },
    });
    return (record as SettlementRecordEntity) || null;
  }

  public async findExistingSettledRecordForPayment(
    paymentId: string
  ): Promise<SettlementRecordEntity | null> {
    const record = await this.client.settlementRecord.findFirst({
      where: {
        paymentId,
        status: { in: [SettlementRecordStatus.INCLUDED, SettlementRecordStatus.SETTLED] },
      },
    });
    return (record as SettlementRecordEntity) || null;
  }

  public async updateRecordsStatusByBatch(
    batchId: string,
    status: SettlementRecordStatus
  ): Promise<void> {
    await this.client.settlementRecord.updateMany({
      where: { batchId, status: { not: SettlementRecordStatus.EXCLUDED } },
      data: { status },
    });
  }

  public async findEligiblePaymentsForPeriod(
    merchantId: string,
    currency: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<any[]> {
    return this.client.payment.findMany({
      where: {
        merchantId,
        currency,
        status: {
          in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'SETTLED'] as any,
        },
        createdAt: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  public async findUnresolvedDiscrepancyForPayment(paymentId: string): Promise<any | null> {
    const record = await this.client.reconciliationRecord.findFirst({
      where: {
        internalTransactionId: paymentId,
        status: { in: ['OPEN', 'INVESTIGATING'] },
        result: { not: 'MATCHED' },
      },
      select: {
        id: true,
        runId: true,
        result: true,
        status: true,
        differenceMinor: true,
      },
    });

    if (!record) return null;

    return {
      id: record.id,
      runId: record.runId,
      discrepancyType: record.result,
      status: record.status,
      amountDifferenceMinor: record.differenceMinor,
    };
  }
}

export class InMemorySettlementRepository implements ISettlementRepository {
  private batches = new Map<string, SettlementBatchEntity>();
  private records = new Map<string, SettlementRecordEntity>();
  private mockPayments: any[] = [];
  private mockDiscrepancies = new Map<string, any>();
  private paymentSupplier?: () => Promise<any[]> | any[];

  public setPaymentSupplier(supplier: () => Promise<any[]> | any[]): void {
    this.paymentSupplier = supplier;
  }

  public setMockPayments(payments: any[]): void {
    this.mockPayments = payments;
  }

  public setMockDiscrepancy(paymentId: string, discrepancy: any): void {
    this.mockDiscrepancies.set(paymentId, discrepancy);
  }

  public async createBatch(batch: SettlementBatchEntity): Promise<SettlementBatchEntity> {
    // Synchronous unique check on [merchantId, currency, periodStart, periodEnd]
    const pStartTime = new Date(batch.periodStart).getTime();
    const pEndTime = new Date(batch.periodEnd).getTime();

    for (const b of this.batches.values()) {
      if (
        b.merchantId === batch.merchantId &&
        b.currency === batch.currency &&
        new Date(b.periodStart).getTime() === pStartTime &&
        new Date(b.periodEnd).getTime() === pEndTime
      ) {
        throw new ConflictError(
          `Settlement batch for merchant ${batch.merchantId}, ${batch.currency} and period already exists`
        );
      }
    }
    const cloned = { ...batch };
    this.batches.set(batch.id, cloned);
    return cloned;
  }

  public async findBatchById(id: string): Promise<SettlementBatchEntity | null> {
    const batch = this.batches.get(id);
    return batch ? { ...batch } : null;
  }

  public async findBatchByMerchantAndPeriod(
    merchantId: string,
    currency: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<SettlementBatchEntity | null> {
    for (const b of this.batches.values()) {
      if (
        b.merchantId === merchantId &&
        b.currency === currency &&
        new Date(b.periodStart).getTime() === new Date(periodStart).getTime() &&
        new Date(b.periodEnd).getTime() === new Date(periodEnd).getTime()
      ) {
        return { ...b };
      }
    }
    return null;
  }

  public async findBatches(
    filter: SettlementFilter
  ): Promise<{ batches: SettlementBatchEntity[]; total: number }> {
    let list = Array.from(this.batches.values());

    if (filter.merchantId) list = list.filter((b) => b.merchantId === filter.merchantId);
    if (filter.currency) list = list.filter((b) => b.currency === filter.currency);
    if (filter.status) list = list.filter((b) => b.status === filter.status);
    if (filter.fromDate) {
      const from = new Date(filter.fromDate).getTime();
      list = list.filter((b) => new Date(b.createdAt).getTime() >= from);
    }
    if (filter.toDate) {
      const to = new Date(filter.toDate).getTime();
      list = list.filter((b) => new Date(b.createdAt).getTime() <= to);
    }

    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 20;
    const skip = (page - 1) * limit;

    const pageItems = list.slice(skip, skip + limit).map((b) => ({ ...b }));
    return { batches: pageItems, total: list.length };
  }

  public async updateBatch(
    id: string,
    updates: Partial<SettlementBatchEntity>
  ): Promise<SettlementBatchEntity> {
    const existing = this.batches.get(id);
    if (!existing) {
      throw new NotFoundError('SettlementBatch', id);
    }
    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.batches.set(id, updated);
    return { ...updated };
  }

  public async createRecordsBatch(records: SettlementRecordEntity[]): Promise<void> {
    for (const r of records) {
      this.records.set(r.id, { ...r });
    }
  }

  public async findRecordsByBatchId(
    filter: SettlementRecordFilter
  ): Promise<{ records: SettlementRecordEntity[]; total: number }> {
    let list = Array.from(this.records.values()).filter((r) => r.batchId === filter.batchId);
    if (filter.status) {
      list = list.filter((r) => r.status === filter.status);
    }
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const skip = (page - 1) * limit;

    const pageItems = list.slice(skip, skip + limit).map((r) => ({ ...r }));
    return { records: pageItems, total: list.length };
  }

  public async findRecordByPaymentId(paymentId: string): Promise<SettlementRecordEntity | null> {
    for (const r of this.records.values()) {
      if (r.paymentId === paymentId) return { ...r };
    }
    return null;
  }

  public async findExistingSettledRecordForPayment(
    paymentId: string
  ): Promise<SettlementRecordEntity | null> {
    for (const r of this.records.values()) {
      if (
        r.paymentId === paymentId &&
        (r.status === SettlementRecordStatus.INCLUDED || r.status === SettlementRecordStatus.SETTLED)
      ) {
        return { ...r };
      }
    }
    return null;
  }

  public async updateRecordsStatusByBatch(
    batchId: string,
    status: SettlementRecordStatus
  ): Promise<void> {
    for (const [id, r] of this.records.entries()) {
      if (r.batchId === batchId && r.status !== SettlementRecordStatus.EXCLUDED) {
        this.records.set(id, { ...r, status, updatedAt: new Date() });
      }
    }
  }

  public async findEligiblePaymentsForPeriod(
    merchantId: string,
    currency: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<any[]> {
    const start = new Date(periodStart).getTime();
    const end = new Date(periodEnd).getTime();

    let allPayments = [...this.mockPayments];
    if (this.paymentSupplier) {
      try {
        const supplied = await this.paymentSupplier();
        if (Array.isArray(supplied) && supplied.length > 0) {
          allPayments = [...allPayments, ...supplied];
        }
      } catch {
        // fallback to mockPayments
      }
    }

    return allPayments.filter((p) => {
      const pTime = new Date(p.createdAt).getTime();
      return (
        p.merchantId === merchantId &&
        p.currency === currency &&
        (p.status === 'CAPTURED' || p.status === 'PARTIALLY_REFUNDED' || p.status === 'SETTLED') &&
        pTime >= start &&
        pTime <= end
      );
    });
  }

  public async findUnresolvedDiscrepancyForPayment(paymentId: string): Promise<any | null> {
    return this.mockDiscrepancies.get(paymentId) || null;
  }

  public clear(): void {
    this.batches.clear();
    this.records.clear();
    this.mockPayments = [];
    this.mockDiscrepancies.clear();
  }
}
