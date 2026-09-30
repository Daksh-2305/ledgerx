import { Request, Response, NextFunction } from 'express';
import { getRedisRateLimiterService } from '../../infra/redis/redis-rate-limiter.service.js';
import { RateLimitExceededError } from '../errors.js';
import { config } from '../../config/index.js';

export interface RateLimiterOptions {
  limit?: number;
  windowSec?: number;
  identifierFn?: (req: Request) => string;
}

export function rateLimiterMiddleware(options: RateLimiterOptions = {}) {
  const limit = options.limit ?? config.RATE_LIMIT_MAX_REQUESTS;
  const windowSec = options.windowSec ?? config.RATE_LIMIT_WINDOW_SECS;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.RATE_LIMIT_ENABLED) {
      return next();
    }

    if (config.NODE_ENV === 'test' && !req.headers['x-merchant-id'] && !req.body?.merchant_id) {
      return next();
    }

    const identifier =
      options.identifierFn?.(req) ||
      (req.headers['x-merchant-id'] as string) ||
      (req.body?.merchant_id as string) ||
      (req.headers['x-forwarded-for'] as string) ||
      req.socket.remoteAddress ||
      'anonymous';

    try {
      const rateLimiter = getRedisRateLimiterService();
      const result = await rateLimiter.consume(identifier, limit, windowSec);

      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader('X-RateLimit-Reset', String(result.resetAt));

      if (!result.allowed) {
        throw new RateLimitExceededError(
          `Rate limit exceeded for identifier '${identifier}'. Try again in ${result.retryAfterSeconds} seconds.`,
          result.retryAfterSeconds
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
