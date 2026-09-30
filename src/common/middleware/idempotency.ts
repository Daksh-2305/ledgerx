import { Request, Response, NextFunction } from 'express';
import { getIdempotencyService } from '../idempotency/idempotency.service.js';
import { logger } from '../logger.js';

export function idempotencyMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Only apply to state-mutating requests (POST, PUT, PATCH, DELETE)
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    const idempotencyKey =
      (req.headers['idempotency-key'] as string) ||
      (req.headers['x-idempotency-key'] as string);

    if (!idempotencyKey) {
      return next();
    }

    try {
      const idempotencyService = await getIdempotencyService();
      const merchantId = (req.body?.merchant_id as string) || null;

      const lookup = await idempotencyService.processOrLookup(
        idempotencyKey,
        merchantId,
        req.method,
        req.path,
        req.body
      );

      // Replay completed result
      if (!lookup.isNew) {
        logger.info(`Replaying cached idempotent response for key: ${idempotencyKey}`, {
          correlationId: req.correlationId,
          requestId: req.requestId,
          event: 'idempotency.replay',
          key: idempotencyKey,
          statusCode: lookup.responseStatus,
        });

        res.setHeader('x-idempotency-replayed', 'true');
        res.setHeader('idempotency-key', idempotencyKey);
        res.status(lookup.responseStatus || 200).json(lookup.responseBody);
        return;
      }

      // Intercept outgoing response to store result
      const originalJson = res.json.bind(res);
      let capturedBody: unknown = null;

      res.json = (body: unknown): Response => {
        capturedBody = body;
        return originalJson(body);
      };

      res.on('finish', async () => {
        try {
          if (res.statusCode < 400) {
            await idempotencyService.markCompleted(idempotencyKey, res.statusCode, capturedBody);
          } else {
            await idempotencyService.markFailed(idempotencyKey);
          }
        } catch (err) {
          logger.error('Failed to update idempotency record status', {
            error: { name: 'IdempotencyError', message: String(err) },
          });
        }
      });

      next();
    } catch (err) {
      next(err);
    }
  };
}
