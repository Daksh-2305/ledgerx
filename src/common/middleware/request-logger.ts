import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { prometheusRegistry } from '../metrics/prometheus.js';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const durationMs = Date.now() - (req.startTime || Date.now());
    const status = res.statusCode >= 400 ? 'FAILED' : 'SUCCESS';

    const normalizedRoute = req.baseUrl || req.path || 'unknown';
    prometheusRegistry.httpRequestsTotal.inc({
      method: req.method,
      route: normalizedRoute,
      status: String(res.statusCode),
    });
    prometheusRegistry.httpRequestDurationSeconds.observe(durationMs / 1000, {
      method: req.method,
      route: normalizedRoute,
    });

    logger.info(`HTTP ${req.method} ${req.originalUrl || req.url} ${res.statusCode}`, {
      correlationId: req.correlationId,
      requestId: req.requestId,
      traceId: req.traceId,
      spanId: req.spanId,
      event: 'http.request',
      status,
      durationMs,
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
  });

  next();
}
