import { Router, Request, Response, NextFunction } from 'express';
import { getWebhookContainer } from './webhook.container.js';
import { adminAuthMiddleware } from '../../common/middleware/admin-auth.js';

export const webhookRouter = Router();

// Lazy controller resolution to support container overrides in tests
const getController = async () => (await getWebhookContainer()).controller;

// ==========================================
// Administrative Dead Letter Queue (DLQ) APIs
// MUST be declared before parameterized /:provider routes
// ==========================================
webhookRouter.get(
  '/dead-letter',
  adminAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    (await getController()).listDeadLetterEvents(req, res, next);
  }
);

webhookRouter.get(
  '/dead-letter/:id',
  adminAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    (await getController()).getDeadLetterEventById(req, res, next);
  }
);

webhookRouter.post(
  '/dead-letter/:id/retry',
  adminAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    (await getController()).retryDeadLetterEvent(req, res, next);
  }
);

webhookRouter.post(
  '/dead-letter/:id/resolve',
  adminAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    (await getController()).resolveDeadLetterEvent(req, res, next);
  }
);

// ==========================================
// Webhook Inspection APIs
// ==========================================
webhookRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).listWebhooks(req, res, next);
});

webhookRouter.get('/events/:id', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).getWebhookById(req, res, next);
});

// ==========================================
// Webhook Ingestion API
// POST /api/v1/webhooks/:provider
// ==========================================
webhookRouter.post('/:provider', async (req: Request, res: Response, next: NextFunction) => {
  (await getController()).ingestWebhook(req, res, next);
});
