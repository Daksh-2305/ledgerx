import { Router } from 'express';
import { SettlementController } from './settlement.controller.js';

export function createSettlementRouter(controller: SettlementController): Router {
  const router = Router();

  // Create settlement batch (asynchronous 202 Accepted)
  router.post('/batches', controller.createBatch);

  // List settlement batches with filtering & pagination
  router.get('/', controller.listBatches);

  // Get specific settlement batch by ID
  router.get('/:id', controller.getBatchById);

  // Get records for a settlement batch with filtering & pagination
  router.get('/:id/records', controller.getBatchRecords);

  // Get settlement financial report summary
  router.get('/:id/report', controller.getSettlementReport);

  // Trigger batch processing
  router.post('/:id/process', controller.processBatch);

  // Trigger settlement payout execution & ledger posting
  router.post('/:id/settle', controller.executeSettlement);

  // Cancel settlement batch
  router.post('/:id/cancel', controller.cancelBatch);

  return router;
}
