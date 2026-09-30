import { Request, Response, NextFunction } from 'express';
import { RiskService } from './risk.service.js';
import { RiskDecision, RiskLevel } from './risk.types.js';

export class RiskController {
  constructor(private readonly service: RiskService) {}

  /**
   * Get risk assessment by payment ID (GET /api/v1/risk/payments/:paymentId)
   */
  public getAssessmentByPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const paymentId = req.params.paymentId as string;
      const assessment = await this.service.getAssessmentByPaymentId(paymentId);
      res.status(200).json({
        success: true,
        data: assessment,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Get risk assessment by assessment ID (GET /api/v1/risk/assessments/:id)
   */
  public getAssessmentById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const assessment = await this.service.getAssessmentById(id);
      res.status(200).json({
        success: true,
        data: assessment,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * List risk assessments with filters (GET /api/v1/risk/assessments)
   */
  public listAssessments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { payment_id, risk_level, decision, from, to, page, limit } = req.query;

      const filter = {
        paymentId: typeof payment_id === 'string' ? payment_id : undefined,
        riskLevel: typeof risk_level === 'string' ? (risk_level as RiskLevel) : undefined,
        decision: typeof decision === 'string' ? (decision as RiskDecision) : undefined,
        from: typeof from === 'string' ? new Date(from) : undefined,
        to: typeof to === 'string' ? new Date(to) : undefined,
        page: page ? parseInt(page as string, 10) : 1,
        limit: limit ? parseInt(limit as string, 10) : 50,
      };

      const result = await this.service.listAssessments(filter);
      res.status(200).json({
        success: true,
        data: result.assessments,
        pagination: {
          total: result.total,
          page: filter.page,
          limit: filter.limit,
          totalPages: Math.ceil(result.total / filter.limit) || 1,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
