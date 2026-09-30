import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      requestId: string;
      traceId: string;
      spanId: string;
      startTime: number;
    }
  }
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId =
    (req.headers['x-correlation-id'] as string) ||
    (req.headers['x-request-id'] as string) ||
    crypto.randomUUID();

  const requestId = crypto.randomUUID();

  // W3C TraceContext or custom headers
  const traceparent = req.headers['traceparent'] as string | undefined;
  let traceId = (req.headers['x-trace-id'] as string) || '';
  let spanId = (req.headers['x-span-id'] as string) || '';

  if (traceparent && traceparent.startsWith('00-')) {
    const parts = traceparent.split('-');
    if (parts.length >= 3) {
      traceId = parts[1] || '';
      spanId = parts[2] || '';
    }
  }

  if (!traceId) {
    traceId = crypto.randomBytes(16).toString('hex');
  }
  if (!spanId) {
    spanId = crypto.randomBytes(8).toString('hex');
  }

  req.correlationId = correlationId;
  req.requestId = requestId;
  req.traceId = traceId;
  req.spanId = spanId;
  req.startTime = Date.now();

  res.setHeader('x-correlation-id', correlationId);
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-trace-id', traceId);
  res.setHeader('x-span-id', spanId);
  res.setHeader('traceparent', `00-${traceId}-${spanId}-01`);

  next();
}

