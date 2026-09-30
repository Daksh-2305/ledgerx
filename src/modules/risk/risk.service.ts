import { IRiskRepository } from './risk.repository.js';
import {
  IRiskRule,
  RiskAssessmentEntity,
  RiskAssessmentFilter,
  RiskDecision,
  RiskLevel,
  RiskRuleContext,
  RiskRuleResult,
} from './risk.types.js';
import { createDefaultRiskRules } from './risk.rules.js';
import { config } from '../../config/index.js';
import { logger } from '../../common/logger.js';
import { NotFoundError } from '../../common/errors.js';
import { KafkaProducerService, getKafkaProducerService } from '../../infra/kafka/kafka-producer.js';
import { createEventEnvelope, KafkaTopics } from '../../infra/kafka/event-envelope.js';
import { IRedisClient } from '../../infra/redis/redis.client.js';

export interface RiskServiceOptions {
  repository: IRiskRepository;
  rules?: IRiskRule[];
  kafkaProducer?: KafkaProducerService;
  modelVersion?: string;
  redisClient?: IRedisClient;
}

export class RiskService {
  private readonly repository: IRiskRepository;
  private readonly rules: IRiskRule[];
  private readonly kafkaProducer: KafkaProducerService;
  private readonly modelVersion: string;

  constructor(
    repoOrOptions: IRiskRepository | RiskServiceOptions,
    rules?: IRiskRule[],
    kafkaProducer?: KafkaProducerService,
    modelVersion = 'rules-v1'
  ) {
    if ('repository' in repoOrOptions) {
      this.repository = repoOrOptions.repository;
      this.rules = repoOrOptions.rules ?? createDefaultRiskRules(repoOrOptions.redisClient ? async () => repoOrOptions.redisClient! : undefined);
      this.kafkaProducer = repoOrOptions.kafkaProducer ?? getKafkaProducerService();
      this.modelVersion = repoOrOptions.modelVersion ?? 'rules-v1';
    } else {
      this.repository = repoOrOptions;
      this.rules = rules ?? createDefaultRiskRules();
      this.kafkaProducer = kafkaProducer ?? getKafkaProducerService();
      this.modelVersion = modelVersion;
    }
  }

  /**
   * Evaluates all modular risk rules for a payment transaction, calculates risk score,
   * determines level and decision, persists assessment, and publishes event.
   */
  public async evaluatePayment(context: RiskRuleContext): Promise<RiskAssessmentEntity> {
    const startTime = performance.now();

    // 1. Idempotency Check: Don't recreate assessment for same payment
    const existing = await this.repository.findByPaymentId(context.paymentId);
    if (existing) {
      logger.info(`Risk assessment already exists for payment ${context.paymentId}; returning existing`, {
        event: 'risk.already_evaluated',
        paymentId: context.paymentId,
        assessmentId: existing.id,
        decision: existing.decision,
      });
      return existing;
    }

    // 2. Evaluate all modular rules
    const ruleResults: RiskRuleResult[] = await Promise.all(
      this.rules.map(async (rule) => {
        try {
          return await rule.evaluate(context);
        } catch (err) {
          logger.error(`Error evaluating rule ${rule.id} for payment ${context.paymentId}`, {
            ruleId: rule.id,
            error: { message: err instanceof Error ? err.message : String(err) },
          });
          return {
            rule_id: rule.id,
            rule_name: rule.name,
            triggered: false,
            score: 0,
            reason: 'Rule evaluation error',
            metadata: { error: true },
          };
        }
      })
    );

    // 3. Calculate Risk Score (Sum of triggered rules clamped 0..100)
    const rawScore = ruleResults.reduce((acc, r) => (r.triggered ? acc + r.score : acc), 0);
    const riskScore = Math.max(0, Math.min(100, rawScore));

    // 4. Map to Risk Level
    const riskLevel = this.calculateRiskLevel(riskScore);

    // 5. Determine Decision (ALLOW, REVIEW, BLOCK)
    const decision = this.calculateDecision(riskLevel);

    // 6. Check for Redis signal degradation
    const isDegraded = ruleResults.some((r) => r.metadata?.degraded === true);
    const evaluationStatus = isDegraded ? 'DEGRADED' : 'COMPLETED';

    const durationMs = Math.round(performance.now() - startTime);

    // 7. Persist Assessment in PostgreSQL
    const assessment = await this.repository.saveAssessment({
      paymentId: context.paymentId,
      riskScore,
      riskLevel,
      decision,
      triggeredRules: ruleResults,
      modelVersion: this.modelVersion,
      evaluationDurationMs: durationMs,
      correlationId: context.correlationId || null,
      evaluationStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    logger.info(`Risk evaluated for payment ${context.paymentId}: Score ${riskScore} (${riskLevel}) -> ${decision}`, {
      event: 'risk.evaluated',
      paymentId: context.paymentId,
      assessmentId: assessment.id,
      riskScore,
      riskLevel,
      decision,
      durationMs,
      evaluationStatus,
      triggeredRulesCount: ruleResults.filter((r) => r.triggered).length,
    });

    // 8. Publish payment.risk.evaluated to Kafka
    const envelope = createEventEnvelope({
      eventType: 'payment.risk.evaluated',
      aggregateType: 'payment',
      aggregateId: context.paymentId,
      correlationId: context.correlationId,
      producer: 'risk-engine',
      payload: {
        payment_id: context.paymentId,
        merchant_id: context.merchantId,
        customer_id: context.customerId,
        amount_minor: Number(context.amountMinor),
        currency: context.currency,
        risk_score: riskScore,
        risk_level: riskLevel,
        decision,
        model_version: this.modelVersion,
        rules_triggered: ruleResults
          .filter((r) => r.triggered)
          .map((r) => ({
            rule_id: r.rule_id,
            score: r.score,
            reason: r.reason,
          })),
        evaluated_at: new Date().toISOString(),
      },
    });

    try {
      await this.kafkaProducer.publishEvent(envelope, KafkaTopics.PAYMENT_EVENTS);
    } catch (err) {
      logger.error(`Failed to publish risk evaluated event to Kafka for payment ${context.paymentId}`, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }

    return assessment;
  }

  public calculateRiskLevel(score: number): RiskLevel {
    if (score <= config.RISK_LEVEL_LOW_MAX) return 'LOW';
    if (score <= config.RISK_LEVEL_MEDIUM_MAX) return 'MEDIUM';
    if (score <= config.RISK_LEVEL_HIGH_MAX) return 'HIGH';
    return 'CRITICAL';
  }

  public mapScoreToRiskLevel(score: number): RiskLevel {
    return this.calculateRiskLevel(score);
  }

  public calculateDecision(level: RiskLevel): RiskDecision {
    switch (level) {
      case 'LOW':
        return 'ALLOW';
      case 'MEDIUM':
        return 'ALLOW';
      case 'HIGH':
        return 'REVIEW';
      case 'CRITICAL':
        return 'BLOCK';
    }
  }

  public mapRiskLevelToDecision(level: RiskLevel): RiskDecision {
    return this.calculateDecision(level);
  }

  public async getAssessmentById(id: string): Promise<RiskAssessmentEntity> {
    const assessment = await this.repository.findById(id);
    if (!assessment) {
      throw new NotFoundError('RiskAssessment', id);
    }
    return assessment;
  }

  public async getAssessmentByPaymentId(paymentId: string): Promise<RiskAssessmentEntity> {
    const assessment = await this.repository.findByPaymentId(paymentId);
    if (!assessment) {
      throw new NotFoundError('RiskAssessment for Payment', paymentId);
    }
    return assessment;
  }

  public async listAssessments(filter: RiskAssessmentFilter) {
    return this.repository.findAssessments(filter);
  }
}
