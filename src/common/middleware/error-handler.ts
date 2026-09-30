import { Request, Response, NextFunction } from 'express';
import { AppError, RateLimitExceededError } from '../errors.js';
import { logger } from '../logger.js';

export function errorHandlerMiddleware(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const correlationId = req.correlationId || 'unknown';
  const requestId = req.requestId || 'unknown';

  if (err instanceof AppError) {
    if (err instanceof RateLimitExceededError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }

    logger.warn(`Application error: ${err.message}`, {
      correlationId,
      requestId,
      event: 'app.error',
      status: 'FAILED',
      errorCode: err.errorCode,
      statusCode: err.statusCode,
      details: err.details,
    });

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.errorCode,
        message: err.message,
        details: err.details || null,
      },
      meta: {
        correlationId,
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
    return;
  }

  // Handle unexpected internal server errors
  logger.error(`Unhandled internal server error: ${err.message}`, {
    correlationId,
    requestId,
    event: 'internal.error',
    status: 'CRITICAL',
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack,
    },
  });

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred. Please contact system support.',
      details: null,
    },
    meta: {
      correlationId,
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
}
