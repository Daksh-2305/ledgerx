import { Router, Request, Response, NextFunction } from 'express';
import { getRiskContainer } from './risk.container.js';

export const riskRouter = Router();

// Lazy controller resolution to support container overrides in tests
const getController = async () => (await getRiskContainer()).controller;

/**
 * GET /api/v1/risk/payments/:paymentId
 * Get latest risk assessment for a specific payment
 */
riskRouter.get('/payments/:paymentId', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).getAssessmentByPayment(req, res, next);
});

/**
 * GET /api/v1/risk/assessments/:id
 * Get specific risk assessment by its assessment ID
 */
riskRouter.get('/assessments/:id', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).getAssessmentById(req, res, next);
});

/**
 * GET /api/v1/risk/assessments
 * List assessments with filtering (paymentId, riskLevel, decision, date) and pagination
 */
riskRouter.get('/assessments', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).listAssessments(req, res, next);
});
