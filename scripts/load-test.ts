/**
 * LedgerX Performance & Load Testing Suite (Milestone 12)
 * Tests Payment Creation, State Machine Transitions, Ledger Posting, and Webhook Ingestion
 * Computes Latency percentiles (min, max, p50, p95, p99), throughput (RPS), and error rate.
 */

import { createServer } from '../src/server.js';
import supertest from 'supertest';
import { generateHmacSignature } from '../src/modules/webhooks/webhook.types.js';
import { config } from '../src/config/index.js';
import { setPaymentContainer, createPaymentContainer, resetPaymentContainer } from '../src/modules/payments/payment.container.js';
import { setLedgerContainer, createLedgerContainer, resetLedgerContainer } from '../src/modules/ledger/ledger.container.js';
import { setWebhookContainer, createWebhookContainer, resetWebhookContainer } from '../src/modules/webhooks/webhook.container.js';
import { setRiskContainer, createRiskContainer, resetRiskContainer } from '../src/modules/risk/risk.container.js';
import { setSettlementContainer, createSettlementContainer, resetSettlementContainer } from '../src/modules/settlements/settlement.container.js';
import { setReconciliationContainer, createReconciliationContainer, resetReconciliationContainer } from '../src/modules/reconciliation/reconciliation.container.js';

interface LatencyStats {
  totalRequests: number;
  successful: number;
  failed: number;
  durationSecs: number;
  rps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

function calculateStats(latencies: number[], durationSecs: number): LatencyStats {
  if (latencies.length === 0) {
    return {
      totalRequests: 0,
      successful: 0,
      failed: 0,
      durationSecs,
      rps: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      minMs: 0,
      maxMs: 0,
    };
  }

  latencies.sort((a, b) => a - b);
  const minMs = latencies[0];
  const maxMs = latencies[latencies.length - 1];
  const p50Ms = latencies[Math.floor(latencies.length * 0.5)];
  const p95Ms = latencies[Math.floor(latencies.length * 0.95)];
  const p99Ms = latencies[Math.floor(latencies.length * 0.99)];
  const successful = latencies.length;
  const rps = parseFloat((successful / (durationSecs || 1)).toFixed(2));

  return {
    totalRequests: latencies.length,
    successful,
    failed: 0,
    durationSecs,
    rps,
    p50Ms,
    p95Ms,
    p99Ms,
    minMs,
    maxMs,
  };
}

export async function runLoadTest(iterations: number = 200, concurrency: number = 10): Promise<{
  paymentCreation: LatencyStats;
  paymentCapture: LatencyStats;
  webhookIngestion: LatencyStats;
}> {
  // Initialize isolated containers
  resetPaymentContainer();
  resetLedgerContainer();
  resetWebhookContainer();
  resetRiskContainer();
  resetSettlementContainer();
  // Disable rate limiting for isolated load testing
  const originalRateLimitEnabled = config.RATE_LIMIT_ENABLED;
  config.RATE_LIMIT_ENABLED = false;

  const { InMemoryLedgerRepository } = await import('../src/modules/ledger/ledger.repository.js');
  const { InMemoryPaymentRepository } = await import('../src/modules/payments/payment.repository.js');
  const { seedDemoData } = await import('../src/modules/payments/payment.container.js');

  const ledgerRepo = new InMemoryLedgerRepository();
  const ledgerC = await createLedgerContainer(ledgerRepo);
  setLedgerContainer(ledgerC);

  const paymentRepo = new InMemoryPaymentRepository();
  await seedDemoData(paymentRepo);
  const paymentC = await createPaymentContainer(paymentRepo, ledgerC.service);
  setPaymentContainer(paymentC);

  const webhookC = await createWebhookContainer();
  setWebhookContainer(webhookC);
  const riskC = await createRiskContainer();
  setRiskContainer(riskC);
  const settleC = await createSettlementContainer();
  setSettlementContainer(settleC);
  const reconC = await createReconciliationContainer();
  setReconciliationContainer(reconC);

  const app = createServer();
  const request = supertest(app);

  const merchantId = '00000000-0000-0000-0000-000000000001';
  const customerId = '00000000-0000-0000-0000-000000000010';

  // 1. Benchmark Payment Creation
  console.log(`\n=== 1. Benchmarking Payment Creation (${iterations} requests, concurrency: ${concurrency}) ===`);
  const createLatencies: number[] = [];
  const createdPaymentIds: string[] = [];
  let createFailed = 0;
  const startCreate = Date.now();

  const batches = Math.ceil(iterations / concurrency);
  for (let b = 0; b < batches; b++) {
    const chunk = Math.min(concurrency, iterations - b * concurrency);
    const promises = Array.from({ length: chunk }).map(async (_, idx) => {
      const idemp = `load_pay_${b}_${idx}_${Date.now()}`;
      const t0 = performance.now();
      const res = await request
        .post('/api/v1/payments')
        .set('Idempotency-Key', idemp)
        .send({
          merchant_id: merchantId,
          customer_id: customerId,
          amount_minor: 50000, // ₹500.00
          currency: 'INR',
          description: 'Load test payment',
        });
      const t1 = performance.now();
      if (res.status === 201 && res.body.data?.id) {
        createLatencies.push(t1 - t0);
        createdPaymentIds.push(res.body.data.id);
      } else {
        createFailed++;
      }
    });
    await Promise.all(promises);
  }
  const createDuration = (Date.now() - startCreate) / 1000;
  const createStats = calculateStats(createLatencies, createDuration);
  createStats.failed = createFailed;
  createStats.totalRequests = iterations;

  // 2. Benchmark Payment Capture & Ledger Posting
  console.log(`\n=== 2. Benchmarking Payment Authorization & Capture (${createdPaymentIds.length} payments) ===`);
  const captureLatencies: number[] = [];
  const startCapture = Date.now();

  for (const payId of createdPaymentIds) {
    // Initiate & Authorize first
    await request.post(`/api/v1/payments/${payId}/initiate`).send();
    await request.post(`/api/v1/payments/${payId}/authorize`).send();

    // Time capture + double-entry ledger posting
    const t0 = performance.now();
    const capRes = await request
      .post(`/api/v1/payments/${payId}/capture`)
      .set('Idempotency-Key', `cap_${payId}`)
      .send();
    const t1 = performance.now();
    if (capRes.status === 200) {
      captureLatencies.push(t1 - t0);
    }
  }
  const captureDuration = (Date.now() - startCapture) / 1000;
  const captureStats = calculateStats(captureLatencies, captureDuration);

  // 3. Benchmark Webhook Ingestion (Signature Validation + Idempotency)
  console.log(`\n=== 3. Benchmarking Webhook Ingestion (${iterations} events) ===`);
  const webhookLatencies: number[] = [];
  const startWebhook = Date.now();

  for (let i = 0; i < iterations; i++) {
    const rawPayload = {
      event_id: `evt_load_${i}_${Date.now()}`,
      event_type: 'payment.captured',
      data: {
        payment_id: createdPaymentIds[i % createdPaymentIds.length] || '00000000-0000-0000-0000-000000000001',
        amount: 50000,
        currency: 'INR',
        status: 'CAPTURED',
      },
    };
    const rawBody = JSON.stringify(rawPayload);
    const signature = generateHmacSignature(config.WEBHOOK_SECRET, rawBody);

    const t0 = performance.now();
    const whRes = await request
      .post('/api/v1/webhooks/mockpay')
      .set('Content-Type', 'application/json')
      .set('x-mockpay-signature', signature)
      .send(rawPayload);
    const t1 = performance.now();

    if (whRes.status === 200 || whRes.status === 202) {
      webhookLatencies.push(t1 - t0);
    }
  }
  const webhookDuration = (Date.now() - startWebhook) / 1000;
  const webhookStats = calculateStats(webhookLatencies, webhookDuration);

  config.RATE_LIMIT_ENABLED = originalRateLimitEnabled;

  return {
    paymentCreation: createStats,
    paymentCapture: captureStats,
    webhookIngestion: webhookStats,
  };
}

// Execute standalone if called directly
if (process.argv[1]?.endsWith('load-test.ts') || process.argv[1]?.endsWith('load-test.js')) {
  runLoadTest(100, 5)
    .then((results) => {
      console.log('\n================ LOAD TEST RESULTS ================');
      console.log('Payment Creation:', JSON.stringify(results.paymentCreation, null, 2));
      console.log('Payment Capture & Ledger:', JSON.stringify(results.paymentCapture, null, 2));
      console.log('Webhook Ingestion:', JSON.stringify(results.webhookIngestion, null, 2));
      console.log('===================================================\n');
    })
    .catch((err) => {
      console.error('Load test failed:', err);
      process.exit(1);
    });
}
