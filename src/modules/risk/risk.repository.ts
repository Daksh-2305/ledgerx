import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import { getPrismaClient } from '../../db/client.js';
import { RiskAssessmentEntity, RiskAssessmentFilter, RiskDecision, RiskLevel, RiskRuleResult } from './risk.types.js';

export interface IRiskRepository {
  saveAssessment(data: Partial<RiskAssessmentEntity>): Promise<RiskAssessmentEntity>;
  save(data: Partial<RiskAssessmentEntity>): Promise<RiskAssessmentEntity>;
  findById(id: string): Promise<RiskAssessmentEntity | null>;
  findByPaymentId(paymentId: string): Promise<RiskAssessmentEntity | null>;
  findAssessments(filter: RiskAssessmentFilter): Promise<{ assessments: RiskAssessmentEntity[]; total: number }>;
  list(filter: RiskAssessmentFilter): Promise<{ assessments?: RiskAssessmentEntity[]; data: RiskAssessmentEntity[]; total: number }>;
  clear?(): Promise<void>;
}

export class PrismaRiskRepository implements IRiskRepository {
  constructor(private client: PrismaClient = getPrismaClient()) {}

  public async saveAssessment(data: Partial<RiskAssessmentEntity>): Promise<RiskAssessmentEntity> {
    const raw = await this.client.riskAssessment.create({
      data: {
        id: data.id ?? crypto.randomUUID(),
        paymentId: data.paymentId!,
        riskScore: data.riskScore ?? 0,
        riskLevel: data.riskLevel as any,
        decision: data.decision as any,
        triggeredRules: (data.triggeredRules ?? []) as any,
        modelVersion: data.modelVersion ?? 'rules-v1',
        evaluationDurationMs: data.evaluationDurationMs ?? null,
        correlationId: data.correlationId ?? null,
        evaluationStatus: data.evaluationStatus ?? 'COMPLETED',
        createdAt: data.createdAt ?? new Date(),
        updatedAt: data.updatedAt ?? new Date(),
      },
    });

    return this.toEntity(raw);
  }

  public async save(data: Partial<RiskAssessmentEntity>): Promise<RiskAssessmentEntity> {
    return this.saveAssessment(data);
  }

  public async list(filter: RiskAssessmentFilter): Promise<{ assessments: RiskAssessmentEntity[]; data: RiskAssessmentEntity[]; total: number }> {
    const res = await this.findAssessments(filter);
    return { assessments: res.assessments, data: res.assessments, total: res.total };
  }

  public async findById(id: string): Promise<RiskAssessmentEntity | null> {
    const raw = await this.client.riskAssessment.findUnique({
      where: { id },
    });
    return raw ? this.toEntity(raw) : null;
  }

  public async findByPaymentId(paymentId: string): Promise<RiskAssessmentEntity | null> {
    const raw = await this.client.riskAssessment.findFirst({
      where: { paymentId },
      orderBy: { createdAt: 'desc' },
    });
    return raw ? this.toEntity(raw) : null;
  }

  public async findAssessments(filter: RiskAssessmentFilter): Promise<{ assessments: RiskAssessmentEntity[]; total: number }> {
    const where: any = {};
    if (filter.paymentId) {
      where.paymentId = filter.paymentId;
    }
    if (filter.riskLevel) {
      where.riskLevel = filter.riskLevel as any;
    }
    if (filter.decision) {
      where.decision = filter.decision as any;
    }
    if (filter.from || filter.to) {
      where.createdAt = {};
      if (filter.from) where.createdAt.gte = filter.from;
      if (filter.to) where.createdAt.lte = filter.to;
    }

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const skip = (page - 1) * limit;

    const [total, raw] = await Promise.all([
      this.client.riskAssessment.count({ where }),
      this.client.riskAssessment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      assessments: raw.map((r) => this.toEntity(r)),
      total,
    };
  }

  private toEntity(raw: any): RiskAssessmentEntity {
    const rules = (raw.triggeredRules as unknown as RiskRuleResult[]) || [];
    return {
      id: raw.id,
      paymentId: raw.paymentId,
      riskScore: raw.riskScore,
      riskLevel: raw.riskLevel as RiskLevel,
      decision: raw.decision as RiskDecision,
      triggeredRules: rules,
      rulesTriggered: rules,
      rules_triggered: rules,
      modelVersion: raw.modelVersion || 'rules-v1',
      evaluationDurationMs: raw.evaluationDurationMs ?? null,
      correlationId: raw.correlationId ?? null,
      evaluationStatus: (raw.evaluationStatus as 'COMPLETED' | 'DEGRADED') || 'COMPLETED',
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }
}

export class InMemoryRiskRepository implements IRiskRepository {
  private assessments = new Map<string, RiskAssessmentEntity>();

  public async saveAssessment(data: Partial<RiskAssessmentEntity>): Promise<RiskAssessmentEntity> {
    const now = new Date();
    const id = data.id || crypto.randomUUID();
    const rules = data.triggeredRules ?? data.rulesTriggered ?? data.rules_triggered ?? [];

    const entity: RiskAssessmentEntity = {
      id,
      paymentId: data.paymentId!,
      riskScore: data.riskScore ?? 0,
      riskLevel: data.riskLevel ?? 'LOW',
      decision: data.decision ?? 'ALLOW',
      triggeredRules: rules,
      rulesTriggered: rules,
      rules_triggered: rules,
      modelVersion: data.modelVersion ?? 'rules-v1',
      evaluationDurationMs: data.evaluationDurationMs ?? null,
      correlationId: data.correlationId ?? null,
      evaluationStatus: data.evaluationStatus ?? 'COMPLETED',
      createdAt: data.createdAt ?? now,
      updatedAt: data.updatedAt ?? now,
    };

    this.assessments.set(id, entity);
    return { ...entity };
  }

  public async save(data: Partial<RiskAssessmentEntity>): Promise<RiskAssessmentEntity> {
    return this.saveAssessment(data);
  }

  public async list(filter: RiskAssessmentFilter): Promise<{ assessments: RiskAssessmentEntity[]; data: RiskAssessmentEntity[]; total: number }> {
    const res = await this.findAssessments(filter);
    return { assessments: res.assessments, data: res.assessments, total: res.total };
  }

  public async findById(id: string): Promise<RiskAssessmentEntity | null> {
    const item = this.assessments.get(id);
    return item ? { ...item } : null;
  }

  public async findByPaymentId(paymentId: string): Promise<RiskAssessmentEntity | null> {
    for (const item of this.assessments.values()) {
      if (item.paymentId === paymentId) {
        return { ...item };
      }
    }
    return null;
  }

  public async findAssessments(filter: RiskAssessmentFilter): Promise<{ assessments: RiskAssessmentEntity[]; total: number }> {
    let list = Array.from(this.assessments.values());

    if (filter.paymentId) {
      list = list.filter((a) => a.paymentId === filter.paymentId);
    }
    if (filter.riskLevel) {
      list = list.filter((a) => a.riskLevel === filter.riskLevel);
    }
    if (filter.decision) {
      list = list.filter((a) => a.decision === filter.decision);
    }
    if (filter.from) {
      list = list.filter((a) => a.createdAt >= filter.from!);
    }
    if (filter.to) {
      list = list.filter((a) => a.createdAt <= filter.to!);
    }

    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const skip = (page - 1) * limit;

    return {
      assessments: list.slice(skip, skip + limit).map((a) => ({ ...a })),
      total: list.length,
    };
  }

  public async clear(): Promise<void> {
    this.assessments.clear();
  }
}
