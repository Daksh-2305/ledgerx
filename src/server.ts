import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index.js';
import { correlationMiddleware } from './common/middleware/correlation.js';
import { requestLoggerMiddleware } from './common/middleware/request-logger.js';
import { idempotencyMiddleware } from './common/middleware/idempotency.js';
import { rateLimiterMiddleware } from './common/middleware/rate-limiter.js';
import { errorHandlerMiddleware } from './common/middleware/error-handler.js';
import { NotFoundError } from './common/errors.js';
import { healthRouter } from './modules/health/health.router.js';
import { paymentsRouter } from './modules/payments/payments.router.js';
import { refundsRouter } from './modules/payments/refunds.router.js';
import { ledgerRouter } from './modules/ledger/ledger.router.js';
import { webhookRouter } from './modules/webhooks/webhook.router.js';
import { riskRouter } from './modules/risk/risk.router.js';
import { reconciliationRouter } from './modules/reconciliation/reconciliation.router.js';
import { settlementRouter } from './modules/settlements/settlement.container.js';
import { dashboardRouter } from './modules/dashboard/dashboard.router.js';

export function createServer(): Express {
  const app = express();

  // Basic security and parsing (Milestone 12 Hardening)
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use(
    cors({
      origin: config.CORS_ORIGIN === '*' ? '*' : config.CORS_ORIGIN.split(',').map((o) => o.trim()),
      credentials: true,
    })
  );
  app.use(
    express.json({
      limit: config.BODY_LIMIT,
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));

  // Tracing and request logging
  app.use(correlationMiddleware);
  app.use(requestLoggerMiddleware);

  // Idempotency middleware for financial mutation APIs
  app.use(idempotencyMiddleware());

  // Health and observability routes (unprefixed for load balancer compatibility)
  app.use('/', healthRouter);

  // Static dashboard frontend
  app.use(express.static('public'));

  // Rate Limiting on API endpoints
  app.use('/api/v1', rateLimiterMiddleware());

  // Core API v1 routes
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/refunds', refundsRouter);
  app.use('/api/v1/ledger', ledgerRouter);
  app.use('/api/v1/webhooks', webhookRouter);
  app.use('/api/v1/risk', riskRouter);
  app.use('/api/v1/reconciliation', reconciliationRouter);
  app.use('/api/v1/settlements', settlementRouter);
  app.use('/api/v1/dashboard', dashboardRouter);

  // SPA fallback for frontend client routing on browser refresh (non-API GET requests)
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/health') ||
      req.path === '/metrics' ||
      req.path === '/ready'
    ) {
      return next();
    }
    res.sendFile('index.html', { root: 'public' });
  });

  // Fallthrough 404 handler
  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(new NotFoundError('API Route', `${req.method} ${req.originalUrl}`));
  });

  // Centralized error handler
  app.use(errorHandlerMiddleware);

  return app;
}
