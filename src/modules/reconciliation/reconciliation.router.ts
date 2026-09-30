import { Router, Request, Response, NextFunction } from 'express';
import { ReconciliationController } from './reconciliation.controller.js';
import { getReconciliationContainer } from './reconciliation.container.js';

export function createReconciliationRouter(controller: ReconciliationController): Router {
  const router = Router();

  // Dashboard & Metrics
  router.get('/dashboard', controller.getDashboard);
  router.get('/metrics', controller.getMetrics);

  // Test Dataset & Import
  router.post('/external-records', controller.importExternalRecords);
  router.post('/generate-test-dataset', controller.generateTestDataset);

  // Reconciliation Runs
  router.post('/runs', controller.createRun);
  router.get('/runs', controller.listRuns);
  router.get('/runs/:runId', controller.getRun);
  router.get('/runs/:runId/summary', controller.getRunSummary);
  router.post('/runs/:runId/execute', controller.executeRun);
  router.get('/runs/:runId/records', controller.getRecords);

  // Reconciliation Records / Discrepancy Lifecycle
  router.get('/records/:id', controller.getRecord);
  router.post('/records/:id/investigate', controller.investigate);
  router.post('/records/:id/resolve', controller.resolve);
  router.post('/records/:id/waive', controller.waive);

  return router;
}

export const reconciliationRouter = Router();

const getController = async () => (await getReconciliationContainer()).controller;

// Dashboard & Metrics
reconciliationRouter.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).getDashboard(req, res, next);
});
reconciliationRouter.get('/metrics', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).getMetrics(req, res, next);
});

// Test Dataset & Import
reconciliationRouter.post('/external-records', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).importExternalRecords(req, res, next);
});
reconciliationRouter.post('/generate-test-dataset', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).generateTestDataset(req, res, next);
});

// Reconciliation Runs
reconciliationRouter.post('/runs', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).createRun(req, res, next);
});
reconciliationRouter.get('/runs', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).listRuns(req, res, next);
});
reconciliationRouter.get('/runs/:runId', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).getRun(req, res, next);
});
reconciliationRouter.get('/runs/:runId/summary', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).getRunSummary(req, res, next);
});
reconciliationRouter.post('/runs/:runId/execute', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).executeRun(req, res, next);
});
reconciliationRouter.get('/runs/:runId/records', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).getRecords(req, res, next);
});

// Reconciliation Records / Discrepancy Lifecycle
reconciliationRouter.get('/records/:id', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).getRecord(req, res, next);
});
reconciliationRouter.post('/records/:id/investigate', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).investigate(req, res, next);
});
reconciliationRouter.post('/records/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).resolve(req, res, next);
});
reconciliationRouter.post('/records/:id/waive', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).waive(req, res, next);
});
