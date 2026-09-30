import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../../config/index.js';
import { UnauthorizedError, ForbiddenError } from '../errors.js';

function timingSafeMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware ensuring administrative access for sensitive operational APIs (such as DLQ management).
 * Validates either the dedicated X-Admin-Key header or an ADMIN role from user context.
 */
export function adminAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const adminKey = req.headers['x-admin-key'];

  // Check direct Admin API Key using timing-safe comparison
  if (adminKey && typeof adminKey === 'string' && timingSafeMatch(adminKey, config.ADMIN_API_KEY)) {
    return next();
  }

  // Check authenticated user role if present
  const user = (req as any).user;
  if (user && user.role === 'ADMIN') {
    return next();
  }

  if (!adminKey && !user) {
    return next(new UnauthorizedError('Admin authentication required (x-admin-key header missing)'));
  }

  return next(new ForbiddenError('Administrative authorization required to access this resource'));
}
