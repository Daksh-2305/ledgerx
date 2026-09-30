export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type RiskDecision = 'ALLOW' | 'REVIEW' | 'BLOCK';

export type RiskRuleId =
  | 'HIGH_PAYMENT_AMOUNT'
  | 'HIGH_PAYMENT_VELOCITY'
  | 'REPEATED_PAYMENT_FAILURES'
  | 'RAPID_TRANSACTION_BURST'
  | 'HIGH_REFUND_VELOCITY';

import type { IRedisClient } from '../../infra/redis/redis.client.js';

export interface RiskRuleContext {
  paymentId: string;
  merchantId: string;
  customerId: string;
  amountMinor: bigint | number;
  currency: string;
  occurredAt?: Date;
  now?: Date;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  redis?: IRedisClient;
}

export interface RiskRuleResult {
  rule_id: RiskRuleId;
  ruleId?: RiskRuleId;
  rule_name: string;
  triggered: boolean;
  score: number;
  reason: string | null;
  metadata?: Record<string, unknown>;
}

export interface IRiskRule {
  readonly id: RiskRuleId;
  readonly name: string;
  readonly description: string;
  evaluate(context: RiskRuleContext): Promise<RiskRuleResult>;
}

export interface RiskAssessmentEntity {
  id: string;
  paymentId: string;
  riskScore: number;
  riskLevel: RiskLevel;
  decision: RiskDecision;
  triggeredRules: RiskRuleResult[];
  rulesTriggered?: RiskRuleResult[];
  rules_triggered?: RiskRuleResult[];
  modelVersion: string;
  evaluationDurationMs: number | null;
  correlationId: string | null;
  evaluationStatus: 'COMPLETED' | 'DEGRADED';
  createdAt: Date;
  updatedAt: Date;
}

export interface RiskAssessmentFilter {
  paymentId?: string;
  riskLevel?: RiskLevel;
  decision?: RiskDecision;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export interface RiskEvaluationPayload {
  payment_id: string;
  merchant_id: string;
  customer_id: string;
  amount_minor: number;
  currency: string;
  risk_score: number;
  risk_level: RiskLevel;
  decision: RiskDecision;
  model_version: string;
  rules_triggered: Array<{
    rule_id: RiskRuleId;
    score: number;
    reason: string | null;
  }>;
  evaluated_at: string;
}
