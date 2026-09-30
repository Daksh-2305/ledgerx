import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createServer } from './server.js';

describe('API Gateway & Server Foundation', () => {
  const app = createServer();

  it('GET /health returns 200 UP with correlation IDs', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UP');
    expect(res.body.service).toBeDefined();
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('preserves incoming x-correlation-id', async () => {
    const customCorrelationId = 'test-corr-id-12345';
    const res = await request(app)
      .get('/health')
      .set('x-correlation-id', customCorrelationId);

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe(customCorrelationId);
  });

  it('GET /ready returns readiness structure and dependency report', async () => {
    const res = await request(app).get('/ready');
    // If local postgres is not running, ready endpoint gracefully returns 503 DEGRADED without crashing
    expect([200, 503]).toContain(res.status);
    expect(res.body.dependencies).toBeDefined();
    expect(res.body.dependencies.database).toBeDefined();
    expect(res.body.memory).toBeDefined();
    expect(res.body.meta).toBeDefined();
  });

  it('GET /api/v1/info returns system architecture information', async () => {
    const res = await request(app).get('/api/v1/info');
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe('LedgerX');
    expect(res.body.services).toBeInstanceOf(Array);
    expect(res.body.supportedCurrencies).toContain('INR');
    expect(res.body.supportedCurrencies).toContain('USD');
  });

  it('returns 404 with structured error response for unmapped endpoints', async () => {
    const res = await request(app).get('/api/v1/unknown-endpoint');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.meta.correlationId).toBeDefined();
  });

  it('returns 200 for implemented /api/v1/payments endpoint', async () => {
    const res = await request(app).get('/api/v1/payments');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('returns 200 for implemented /api/v1/ledger/integrity endpoint', async () => {
    const res = await request(app).get('/api/v1/ledger/integrity');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.healthy).toBe(true);
  });
});
