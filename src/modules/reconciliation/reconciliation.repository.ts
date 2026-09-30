import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import { getPrismaClient } from '../../db/client.js';
import type {
  ReconciliationRunEntity,
  ReconciliationRecordEntity,
  ExternalTransactionEntity,
  InternalRecordSummary,
  ReconciliationRecordFilter,
  ReconciliationRunStatus,
  DiscrepancyStatus,
} from './reconciliation.types.js';

export interface IReconciliationRepository {
  createRun(data: Omit<ReconciliationRunEntity, 'id' | 'createdAt' | 'updatedAt'>): Promise<ReconciliationRunEntity>;
  getRunById(id: string): Promise<ReconciliationRunEntity | null>;
  getRunByReference(reference: string): Promise<ReconciliationRunEntity | null>;
  updateRun(id: string, updates: Partial<ReconciliationRunEntity>): Promise<ReconciliationRunEntity>;
  listRuns(options?: { provider?: string; status?: ReconciliationRunStatus; page?: number; limit?: number }): Promise<{ items: ReconciliationRunEntity[]; total: number }>;

  saveRecordsBatch(records: Omit<ReconciliationRecordEntity, 'id' | 'createdAt' | 'updatedAt'>[]): Promise<number>;
  getRecordsByRunId(filter: ReconciliationRecordFilter): Promise<{ items: ReconciliationRecordEntity[]; total: number }>;
  getRecordById(id: string): Promise<ReconciliationRecordEntity | null>;
  updateRecordStatus(id: string, status: DiscrepancyStatus, resolvedBy?: string | null, resolutionNotes?: string | null): Promise<ReconciliationRecordEntity>;

  saveExternalTransactionsBatch(txs: Omit<ExternalTransactionEntity, 'id' | 'createdAt'>[]): Promise<number>;
  listExternalTransactions(options: { provider: string; periodStart: Date; periodEnd: Date }): Promise<ExternalTransactionEntity[]>;
  listInternalRecords(options: { periodStart: Date; periodEnd: Date }): Promise<InternalRecordSummary[]>;

  createAuditLog(entry: {
    entityType: string;
    entityId: string;
    action: string;
    actorId?: string;
    actorType?: string;
    changes?: Record<string, unknown>;
    correlationId?: string;
  }): Promise<void>;

  getDashboardSummary(): Promise<{
    totalRuns: number;
    recordsProcessed: number;
    matchRate: number;
    openDiscrepancies: number;
    amountMismatches: number;
    missingTransactions: number;
    duplicates: number;
  }>;

  clear?(): Promise<void>;
}

export class PrismaReconciliationRepository implements IReconciliationRepository {
  constructor(private client: PrismaClient = getPrismaClient()) {}

  public async createRun(
    data: Omit<ReconciliationRunEntity, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ReconciliationRunEntity> {
    const raw = await this.client.reconciliationRun.create({
      data: {
        id: crypto.randomUUID(),
        runReference: data.runReference,
        provider: data.provider,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        status: data.status,
        totalInternalRecords: data.totalInternalRecords,
        totalExternalRecords: data.totalExternalRecords,
        matchedCount: data.matchedCount,
        mismatchCount: data.mismatchCount,
        missingInternalCount: data.missingInternalCount,
        missingExternalCount: data.missingExternalCount,
        duplicateCount: data.duplicateCount,
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        errorMessage: data.errorMessage,
      },
    });

    return this.toRunEntity(raw);
  }

  public async getRunById(id: string): Promise<ReconciliationRunEntity | null> {
    const raw = await this.client.reconciliationRun.findUnique({
      where: { id },
    });
    return raw ? this.toRunEntity(raw) : null;
  }

  public async getRunByReference(reference: string): Promise<ReconciliationRunEntity | null> {
    const raw = await this.client.reconciliationRun.findUnique({
      where: { runReference: reference },
    });
    return raw ? this.toRunEntity(raw) : null;
  }

  public async updateRun(id: string, updates: Partial<ReconciliationRunEntity>): Promise<ReconciliationRunEntity> {
    const raw = await this.client.reconciliationRun.update({
      where: { id },
      data: {
        status: updates.status,
        totalInternalRecords: updates.totalInternalRecords,
        totalExternalRecords: updates.totalExternalRecords,
        matchedCount: updates.matchedCount,
        mismatchCount: updates.mismatchCount,
        missingInternalCount: updates.missingInternalCount,
        missingExternalCount: updates.missingExternalCount,
        duplicateCount: updates.duplicateCount,
        startedAt: updates.startedAt,
        completedAt: updates.completedAt,
        errorMessage: updates.errorMessage,
      },
    });

    return this.toRunEntity(raw);
  }

  public async listRuns(options?: {
    provider?: string;
    status?: ReconciliationRunStatus;
    page?: number;
    limit?: number;
  }): Promise<{ items: ReconciliationRunEntity[]; total: number }> {
    const where: any = {};
    if (options?.provider) where.provider = options.provider;
    if (options?.status) where.status = options.status;

    const page = options?.page && options.page > 0 ? options.page : 1;
    const limit = options?.limit && options.limit > 0 ? options.limit : 50;
    const skip = (page - 1) * limit;

    const [total, raw] = await Promise.all([
      this.client.reconciliationRun.count({ where }),
      this.client.reconciliationRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      items: raw.map((r) => this.toRunEntity(r)),
      total,
    };
  }

  public async saveRecordsBatch(
    records: Omit<ReconciliationRecordEntity, 'id' | 'createdAt' | 'updatedAt'>[]
  ): Promise<number> {
    if (records.length === 0) return 0;

    // Batch chunking (500 records per chunk) for safe high-throughput persistence
    const CHUNK_SIZE = 500;
    let savedCount = 0;

    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE);
      await this.client.reconciliationRecord.createMany({
        data: chunk.map((r) => ({
          id: crypto.randomUUID(),
          runId: r.runId,
          internalReference: r.internalReference ?? null,
          externalReference: r.externalReference ?? null,
          internalTransactionId: r.internalTransactionId ?? null,
          externalTransactionId: r.externalTransactionId ?? null,
          externalDbRecordId: r.externalDbRecordId ?? null,
          result: r.result,
          differenceMinor: r.differenceMinor,
          reason: r.reason ?? null,
          status: r.status,
          resolvedBy: r.resolvedBy ?? null,
          resolvedAt: r.resolvedAt ?? null,
          resolutionNotes: r.resolutionNotes ?? null,
          internalAmountMinor: r.internalAmountMinor ?? null,
          externalAmountMinor: r.externalAmountMinor ?? null,
        })),
      });
      savedCount += chunk.length;
    }

    return savedCount;
  }

  public async getRecordsByRunId(
    filter: ReconciliationRecordFilter
  ): Promise<{ items: ReconciliationRecordEntity[]; total: number }> {
    const where: any = { runId: filter.runId };
    if (filter.result) where.result = filter.result;
    if (filter.status) where.status = filter.status;
    if (filter.search) {
      where.OR = [
        { internalReference: { contains: filter.search, mode: 'insensitive' } },
        { externalReference: { contains: filter.search, mode: 'insensitive' } },
        { externalTransactionId: { contains: filter.search, mode: 'insensitive' } },
      ];
    }

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const skip = (page - 1) * limit;

    const [total, raw] = await Promise.all([
      this.client.reconciliationRecord.count({ where }),
      this.client.reconciliationRecord.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      items: raw.map((r) => this.toRecordEntity(r)),
      total,
    };
  }

  public async getRecordById(id: string): Promise<ReconciliationRecordEntity | null> {
    const raw = await this.client.reconciliationRecord.findUnique({
      where: { id },
    });
    return raw ? this.toRecordEntity(raw) : null;
  }

  public async updateRecordStatus(
    id: string,
    status: DiscrepancyStatus,
    resolvedBy?: string | null,
    resolutionNotes?: string | null
  ): Promise<ReconciliationRecordEntity> {
    const raw = await this.client.reconciliationRecord.update({
      where: { id },
      data: {
        status,
        resolvedBy: resolvedBy ?? undefined,
        resolvedAt: status === 'RESOLVED' || status === 'WAIVED' ? new Date() : undefined,
        resolutionNotes: resolutionNotes ?? undefined,
      },
    });

    return this.toRecordEntity(raw);
  }

  public async saveExternalTransactionsBatch(
    txs: Omit<ExternalTransactionEntity, 'id' | 'createdAt'>[]
  ): Promise<number> {
    if (txs.length === 0) return 0;

    const CHUNK_SIZE = 500;
    let count = 0;

    for (let i = 0; i < txs.length; i += CHUNK_SIZE) {
      const chunk = txs.slice(i, i + CHUNK_SIZE);
      await this.client.externalTransaction.createMany({
        data: chunk.map((t) => ({
          id: crypto.randomUUID(),
          provider: t.provider,
          externalTransactionId: t.externalTransactionId,
          externalReference: t.externalReference,
          paymentReference: t.paymentReference ?? null,
          transactionType: t.transactionType,
          amountMinor: t.amountMinor,
          currency: t.currency,
          status: t.status,
          transactionTimestamp: t.transactionTimestamp,
          settlementDate: t.settlementDate ?? null,
          rawData: (t.rawData ?? {}) as any,
        })),
        skipDuplicates: true,
      });
      count += chunk.length;
    }

    return count;
  }

  public async listExternalTransactions(options: {
    provider: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<ExternalTransactionEntity[]> {
    const raw = await this.client.externalTransaction.findMany({
      where: {
        provider: options.provider,
        transactionTimestamp: {
          gte: options.periodStart,
          lte: options.periodEnd,
        },
      },
      orderBy: { transactionTimestamp: 'asc' },
    });

    return raw.map((r) => ({
      id: r.id,
      provider: r.provider,
      externalTransactionId: r.externalTransactionId,
      externalReference: r.externalReference,
      paymentReference: r.paymentReference,
      transactionType: r.transactionType,
      amountMinor: r.amountMinor,
      currency: r.currency,
      status: r.status,
      transactionTimestamp: r.transactionTimestamp,
      settlementDate: r.settlementDate,
      rawData: (r.rawData as Record<string, unknown>) ?? null,
      createdAt: r.createdAt,
    }));
  }

  public async listInternalRecords(options: {
    periodStart: Date;
    periodEnd: Date;
  }): Promise<InternalRecordSummary[]> {
    const payments = await this.client.payment.findMany({
      where: {
        createdAt: {
          gte: options.periodStart,
          lte: options.periodEnd,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return payments.map((p) => ({
      id: p.id,
      reference: p.idempotencyKey || `PAY-${p.id.slice(0, 8).toUpperCase()}`,
      idempotencyKey: p.idempotencyKey,
      amountMinor: p.amountMinor,
      currency: p.currency,
      status: p.status,
      createdAt: p.createdAt,
    }));
  }

  public async createAuditLog(entry: {
    entityType: string;
    entityId: string;
    action: string;
    actorId?: string;
    actorType?: string;
    changes?: Record<string, unknown>;
    correlationId?: string;
  }): Promise<void> {
    await this.client.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        actorId: entry.actorId ?? 'system',
        actorType: entry.actorType ?? 'SYSTEM',
        changes: entry.changes ? (entry.changes as any) : undefined,
        correlationId: entry.correlationId ?? null,
      },
    });
  }

  public async getDashboardSummary(): Promise<{
    totalRuns: number;
    recordsProcessed: number;
    matchRate: number;
    openDiscrepancies: number;
    amountMismatches: number;
    missingTransactions: number;
    duplicates: number;
  }> {
    const [totalRuns, runs, openDiscrepancies, amountMismatches, missingInt, missingExt, duplicates] =
      await Promise.all([
        this.client.reconciliationRun.count(),
        this.client.reconciliationRun.findMany(),
        this.client.reconciliationRecord.count({ where: { status: 'OPEN', result: { not: 'MATCHED' } } }),
        this.client.reconciliationRecord.count({ where: { result: 'AMOUNT_MISMATCH' } }),
        this.client.reconciliationRecord.count({ where: { result: 'MISSING_INTERNAL' } }),
        this.client.reconciliationRecord.count({ where: { result: 'MISSING_EXTERNAL' } }),
        this.client.reconciliationRecord.count({
          where: { result: { in: ['DUPLICATE_EXTERNAL', 'DUPLICATE_INTERNAL'] } },
        }),
      ]);

    const totalProcessed = runs.reduce((sum, r) => sum + r.totalExternalRecords + r.totalInternalRecords, 0);
    const totalMatched = runs.reduce((sum, r) => sum + r.matchedCount, 0);
    const matchRate = totalProcessed > 0 ? Number(((totalMatched / (totalProcessed / 2 || 1)) * 100).toFixed(1)) : 100;

    return {
      totalRuns,
      recordsProcessed: totalProcessed,
      matchRate: Math.min(100, Math.max(0, matchRate)),
      openDiscrepancies,
      amountMismatches,
      missingTransactions: missingInt + missingExt,
      duplicates,
    };
  }

  private toRunEntity(raw: any): ReconciliationRunEntity {
    return {
      id: raw.id,
      runReference: raw.runReference,
      provider: raw.provider,
      periodStart: raw.periodStart,
      periodEnd: raw.periodEnd,
      status: raw.status as ReconciliationRunStatus,
      totalInternalRecords: raw.totalInternalRecords,
      totalExternalRecords: raw.totalExternalRecords,
      matchedCount: raw.matchedCount,
      mismatchCount: raw.mismatchCount,
      missingInternalCount: raw.missingInternalCount,
      missingExternalCount: raw.missingExternalCount,
      duplicateCount: raw.duplicateCount,
      startedAt: raw.startedAt,
      completedAt: raw.completedAt,
      errorMessage: raw.errorMessage,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  private toRecordEntity(raw: any): ReconciliationRecordEntity {
    return {
      id: raw.id,
      runId: raw.runId,
      internalReference: raw.internalReference,
      externalReference: raw.externalReference,
      internalTransactionId: raw.internalTransactionId,
      externalTransactionId: raw.externalTransactionId,
      externalDbRecordId: raw.externalDbRecordId,
      result: raw.result,
      differenceMinor: BigInt(raw.differenceMinor),
      reason: raw.reason,
      status: raw.status,
      resolvedBy: raw.resolvedBy,
      resolvedAt: raw.resolvedAt,
      resolutionNotes: raw.resolutionNotes,
      internalAmountMinor: raw.internalAmountMinor !== null ? BigInt(raw.internalAmountMinor) : null,
      externalAmountMinor: raw.externalAmountMinor !== null ? BigInt(raw.externalAmountMinor) : null,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }
}

/**
 * High-performance In-Memory Repository for Tests and Offline environments.
 */
export class InMemoryReconciliationRepository implements IReconciliationRepository {
  private runs = new Map<string, ReconciliationRunEntity>();
  private records = new Map<string, ReconciliationRecordEntity>();
  private externalTxs = new Map<string, ExternalTransactionEntity>();
  private internalRecords = new Map<string, InternalRecordSummary>();
  private auditLogs: Array<any> = [];

  public async createRun(
    data: Omit<ReconciliationRunEntity, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ReconciliationRunEntity> {
    const id = crypto.randomUUID();
    const now = new Date();
    const entity: ReconciliationRunEntity = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(id, entity);
    return { ...entity };
  }

  public async getRunById(id: string): Promise<ReconciliationRunEntity | null> {
    const run = this.runs.get(id);
    return run ? { ...run } : null;
  }

  public async getRunByReference(reference: string): Promise<ReconciliationRunEntity | null> {
    for (const run of this.runs.values()) {
      if (run.runReference === reference) {
        return { ...run };
      }
    }
    return null;
  }

  public async updateRun(id: string, updates: Partial<ReconciliationRunEntity>): Promise<ReconciliationRunEntity> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Reconciliation run not found: ${id}`);
    const updated: ReconciliationRunEntity = {
      ...run,
      ...updates,
      updatedAt: new Date(),
    };
    this.runs.set(id, updated);
    return { ...updated };
  }

  public async listRuns(options?: {
    provider?: string;
    status?: ReconciliationRunStatus;
    page?: number;
    limit?: number;
  }): Promise<{ items: ReconciliationRunEntity[]; total: number }> {
    let list = Array.from(this.runs.values());
    if (options?.provider) list = list.filter((r) => r.provider === options.provider);
    if (options?.status) list = list.filter((r) => r.status === options.status);

    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const page = options?.page && options.page > 0 ? options.page : 1;
    const limit = options?.limit && options.limit > 0 ? options.limit : 50;
    const skip = (page - 1) * limit;

    return {
      items: list.slice(skip, skip + limit).map((r) => ({ ...r })),
      total: list.length,
    };
  }

  public async saveRecordsBatch(
    records: Omit<ReconciliationRecordEntity, 'id' | 'createdAt' | 'updatedAt'>[]
  ): Promise<number> {
    const now = new Date();
    for (const r of records) {
      const id = crypto.randomUUID();
      const entity: ReconciliationRecordEntity = {
        ...r,
        id,
        createdAt: now,
        updatedAt: now,
      };
      this.records.set(id, entity);
    }
    return records.length;
  }

  public async getRecordsByRunId(
    filter: ReconciliationRecordFilter
  ): Promise<{ items: ReconciliationRecordEntity[]; total: number }> {
    let list = Array.from(this.records.values()).filter((r) => r.runId === filter.runId);

    if (filter.result) list = list.filter((r) => r.result === filter.result);
    if (filter.status) list = list.filter((r) => r.status === filter.status);
    if (filter.search) {
      const search = filter.search.toLowerCase();
      list = list.filter(
        (r) =>
          r.internalReference?.toLowerCase().includes(search) ||
          r.externalReference?.toLowerCase().includes(search) ||
          r.externalTransactionId?.toLowerCase().includes(search)
      );
    }

    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const skip = (page - 1) * limit;

    return {
      items: list.slice(skip, skip + limit).map((r) => ({ ...r })),
      total: list.length,
    };
  }

  public async getRecordById(id: string): Promise<ReconciliationRecordEntity | null> {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  public async updateRecordStatus(
    id: string,
    status: DiscrepancyStatus,
    resolvedBy?: string | null,
    resolutionNotes?: string | null
  ): Promise<ReconciliationRecordEntity> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Reconciliation record not found: ${id}`);
    const updated: ReconciliationRecordEntity = {
      ...record,
      status,
      resolvedBy: resolvedBy ?? record.resolvedBy,
      resolvedAt: status === 'RESOLVED' || status === 'WAIVED' ? new Date() : record.resolvedAt,
      resolutionNotes: resolutionNotes ?? record.resolutionNotes,
      updatedAt: new Date(),
    };
    this.records.set(id, updated);
    return { ...updated };
  }

  public async saveExternalTransactionsBatch(
    txs: Omit<ExternalTransactionEntity, 'id' | 'createdAt'>[]
  ): Promise<number> {
    const now = new Date();
    for (const t of txs) {
      const id = crypto.randomUUID();
      this.externalTxs.set(id, {
        ...t,
        id,
        createdAt: now,
      });
    }
    return txs.length;
  }

  public async listExternalTransactions(options: {
    provider: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<ExternalTransactionEntity[]> {
    return Array.from(this.externalTxs.values())
      .filter(
        (t) =>
          t.provider.toLowerCase() === options.provider.toLowerCase() &&
          t.transactionTimestamp.getTime() >= options.periodStart.getTime() &&
          t.transactionTimestamp.getTime() <= options.periodEnd.getTime()
      )
      .map((t) => ({ ...t }));
  }

  public async listInternalRecords(options: {
    periodStart: Date;
    periodEnd: Date;
  }): Promise<InternalRecordSummary[]> {
    return Array.from(this.internalRecords.values())
      .filter(
        (r) =>
          r.createdAt.getTime() >= options.periodStart.getTime() &&
          r.createdAt.getTime() <= options.periodEnd.getTime()
      )
      .map((r) => ({ ...r }));
  }

  public addInternalRecords(records: InternalRecordSummary[]): void {
    for (const r of records) {
      this.internalRecords.set(r.id, { ...r });
    }
  }

  public async createAuditLog(entry: any): Promise<void> {
    this.auditLogs.push({ ...entry, id: crypto.randomUUID(), createdAt: new Date() });
  }

  public getAuditLogs(): any[] {
    return [...this.auditLogs];
  }

  public async getDashboardSummary(): Promise<{
    totalRuns: number;
    recordsProcessed: number;
    matchRate: number;
    openDiscrepancies: number;
    amountMismatches: number;
    missingTransactions: number;
    duplicates: number;
  }> {
    const runsList = Array.from(this.runs.values());
    const recordsList = Array.from(this.records.values());

    const totalRuns = runsList.length;
    const totalProcessed = runsList.reduce((sum, r) => sum + r.totalExternalRecords + r.totalInternalRecords, 0);
    const totalMatched = runsList.reduce((sum, r) => sum + r.matchedCount, 0);
    const openDiscrepancies = recordsList.filter((r) => r.status === 'OPEN' && r.result !== 'MATCHED').length;
    const amountMismatches = recordsList.filter((r) => r.result === 'AMOUNT_MISMATCH').length;
    const missingInt = recordsList.filter((r) => r.result === 'MISSING_INTERNAL').length;
    const missingExt = recordsList.filter((r) => r.result === 'MISSING_EXTERNAL').length;
    const duplicates = recordsList.filter(
      (r) => r.result === 'DUPLICATE_EXTERNAL' || r.result === 'DUPLICATE_INTERNAL'
    ).length;

    const matchRate = totalProcessed > 0 ? Number(((totalMatched / (totalProcessed / 2 || 1)) * 100).toFixed(1)) : 100;

    return {
      totalRuns,
      recordsProcessed: totalProcessed,
      matchRate: Math.min(100, Math.max(0, matchRate)),
      openDiscrepancies,
      amountMismatches,
      missingTransactions: missingInt + missingExt,
      duplicates,
    };
  }

  public async clear(): Promise<void> {
    this.runs.clear();
    this.records.clear();
    this.externalTxs.clear();
    this.internalRecords.clear();
    this.auditLogs = [];
  }
}
