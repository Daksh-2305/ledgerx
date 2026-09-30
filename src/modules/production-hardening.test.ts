import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import crypto from 'crypto';
import { createServer } from '../server.js';
import { config } from '../config/index.js';
import { setServerShuttingDown } from './health/health.controller.js';
import { redactSensitiveData } from '../common/logger.js';
import { prometheusRegistry } from '../common/metrics/prometheus.js';
import { adminAuthMiddleware } from '../common/middleware/admin-auth.js';
import type { Request, Response, NextFunction } from 'express';

describe('Milestone 12: Production Hardening, Observability & Resilience Suite', () => {
  let app: ReturnType<typeof createServer>;
  let request: ReturnType<typeof supertest>;

  beforeEach(() => {
    setServerShuttingDown(false);
    app = createServer();
    request = supertest(app);
  });

  afterEach(() => {
    setServerShuttingDown(false);
  });

  describe('1. Health, Readiness & Liveness Probes', () => {
    it('GET /health returns process liveness status 200 with service info', async () => {
      const res = await request.get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UP');
      expect(res.body.service).toBe(config.SERVICE_NAME);
      expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(res.body.timestamp).toBeDefined();
    });

    it('GET /ready responds with appropriate status and checks', async () => {
      const res = await request.get('/ready');
      expect([200, 503]).toContain(res.status);
      expect(res.body.status).toBeDefined();
      expect(res.body.dependencies).toBeDefined();
    });

    it('GET /ready returns 503 Service Unavailable when server is shutting down (graceful draining)', async () => {
      setServerShuttingDown(true);
      const res = await request.get('/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('SHUTTING_DOWN');

      // But /health liveness probe remains 200 UP
      const healthRes = await request.get('/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe('UP');
    });

    it('GET /health/dependencies returns comprehensive dependency health', async () => {
      const res = await request.get('/health/dependencies');
      expect([200, 503]).toContain(res.status);
      expect(res.body.dependencies).toBeDefined();
      expect(res.body.dependencies.database).toBeDefined();
      expect(res.body.dependencies.redis).toBeDefined();
      expect(res.body.dependencies.kafka).toBeDefined();
      expect(res.body.memory).toBeDefined();
      expect(res.body.memory.heapUsedBytes).toBeGreaterThan(0);
    });
  });

  describe('2. OpenMetrics & Prometheus Metrics Exposition', () => {
    it('GET /metrics exposes Prometheus-compatible text format metrics', async () => {
      // Record a test metric
      prometheusRegistry.paymentCreatedTotal.inc();

      const res = await request.get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('# TYPE payment_created_total counter');
      expect(res.text).toContain('payment_created_total');
      expect(res.text).toContain('http_requests_total');
    });
  });

  describe('3. Timing-Safe Admin Authentication', () => {
    it('denies access with UnauthorizedError when admin API key is missing', async () => {
      const mockReq = {
        headers: {},
      } as unknown as Request;
      const mockRes = {} as Response;
      let caughtErr: any = null;
      const next: NextFunction = (err?: any) => { caughtErr = err; };

      adminAuthMiddleware(mockReq, mockRes, next);
      expect(caughtErr).toBeDefined();
      expect(caughtErr.statusCode).toBe(401);
    });

    it('denies access with ForbiddenError when admin API key is incorrect', async () => {
      const mockReq = {
        headers: { 'x-admin-key': 'wrong-secret-key-12345' },
      } as unknown as Request;
      const mockRes = {} as Response;
      let caughtErr: any = null;
      const next: NextFunction = (err?: any) => { caughtErr = err; };

      adminAuthMiddleware(mockReq, mockRes, next);
      expect(caughtErr).toBeDefined();
      expect(caughtErr.statusCode).toBe(403);
    });

    it('grants access when valid admin API key is supplied', async () => {
      const mockReq = {
        headers: { 'x-admin-key': config.ADMIN_API_KEY },
      } as unknown as Request;
      const mockRes = {} as Response;
      let caughtErr: any = null;
      const next: NextFunction = (err?: any) => { caughtErr = err; };

      adminAuthMiddleware(mockReq, mockRes, next);
      expect(caughtErr).toBeUndefined();
    });
  });

  describe('4. Secret Redaction in Structured Logging', () => {
    it('recursively redacts sensitive fields from logged objects', () => {
      const sensitiveData = {
        user: 'admin',
        password: 'SuperSecretPassword123!',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
        apiKey: 'sk_live_51ABCDEF1234567890',
        webhook_secret: 'whsec_999999999999',
        authorization: 'Bearer secret_token',
        nested: {
          client_secret: 'oauth_secret_abc',
          safeField: 'visible_data',
        },
      };

      const redacted = redactSensitiveData(sensitiveData);
      expect(redacted.user).toBe('admin');
      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.token).toBe('[REDACTED]');
      expect(redacted.apiKey).toBe('[REDACTED]');
      expect(redacted.webhook_secret).toBe('[REDACTED]');
      expect(redacted.authorization).toBe('[REDACTED]');
      expect(redacted.nested.client_secret).toBe('[REDACTED]');
      expect(redacted.nested.safeField).toBe('visible_data');
    });
  });

  describe('5. Distributed Tracing & Correlation Header Propagation', () => {
    it('generates x-trace-id, x-span-id, and traceparent if none provided', async () => {
      const res = await request.get('/health');
      expect(res.headers['x-trace-id']).toBeDefined();
      expect(res.headers['x-trace-id'].length).toBe(32); // 32 hex chars (128-bit)
      expect(res.headers['x-span-id']).toBeDefined();
      expect(res.headers['x-span-id'].length).toBe(16); // 16 hex chars (64-bit)
      expect(res.headers['traceparent']).toBeDefined();
      expect(res.headers['traceparent']).toContain(res.headers['x-trace-id']);
    });

    it('propagates incoming W3C traceparent header across response', async () => {
      const incomingTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const incomingParentSpanId = '00f067aa0ba902b7';
      const incomingTraceparent = `00-${incomingTraceId}-${incomingParentSpanId}-01`;

      const res = await request
        .get('/health')
        .set('traceparent', incomingTraceparent);

      expect(res.headers['x-trace-id']).toBe(incomingTraceId);
      expect(res.headers['traceparent']).toContain(`00-${incomingTraceId}-`);
    });
  });

  describe('6. Security Headers & CORS Policy', () => {
    it('sets hardened security headers via Helmet', async () => {
      const res = await request.get('/health');
      expect(res.headers['x-dns-prefetch-control']).toBe('off');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });
});
