# LedgerX Production Demonstration Script (M12)

This document provides a concise 5–10 minute step-by-step demonstration walkthrough for engineers, evaluators, and stakeholders. It showcases the architectural guarantees, double-entry financial accounting, idempotency, event-driven messaging, reconciliation, settlements, and production observability.

---

## Prerequisites
1. Start the LedgerX server:
   ```bash
   npm run dev
   ```
2. Set environment variables in your active shell:
   ```bash
   BASE_URL="http://localhost:3000"
   ADMIN_KEY="ledgerx-admin-prod-super-secret-key-replace-in-env"
   ```

---

## 1. System Health & Observability (Minute 1)

### Inspect Process Liveness & Dependencies
```bash
# 1.1 Process Liveness Probe
curl -s "${BASE_URL}/health" | jq .

# 1.2 Deep Dependency Readiness Probe
curl -s "${BASE_URL}/ready" | jq .

# 1.3 Detailed Dependency Latencies (PostgreSQL, Redis, Kafka, Memory)
curl -s "${BASE_URL}/health/dependencies" | jq .
```
**Engineering Focus**: Notice the separation of liveness (`/health`) from readiness (`/ready`). Notice the propagation of correlation IDs and W3C distributed trace headers (`traceparent`, `x-trace-id`, `x-span-id`).

### Inspect Prometheus Metrics Exposition
```bash
curl -s "${BASE_URL}/metrics" | head -n 30
```
**Engineering Focus**: Prometheus text format exposing HTTP latencies, payment lifecycle transitions, ledger transactions, and webhook counts. Notice the complete absence of high-cardinality labels (no payment IDs or user IDs).

---

## 2. Idempotent Payment Creation & Risk Assessment (Minute 2)

### Create Payment Intent with Idempotency Key
```bash
IDEMP_KEY="demo_idemp_$(date +%s)"

curl -s -X POST "${BASE_URL}/api/v1/payments" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${IDEMP_KEY}" \
  -d '{
    "merchant_id": "00000000-0000-0000-0000-000000000001",
    "customer_id": "00000000-0000-0000-0000-000000000010",
    "amount_minor": 150000,
    "currency": "INR",
    "description": "Enterprise Subscription payment"
  }' | jq .
```
Save the returned payment `id` into `PAYMENT_ID`:
```bash
PAYMENT_ID="<COPIED_PAYMENT_ID>"
```

### Idempotency Verification
Replay the exact same `POST` request with the same `Idempotency-Key`:
```bash
curl -s -X POST "${BASE_URL}/api/v1/payments" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${IDEMP_KEY}" \
  -d '{
    "merchant_id": "00000000-0000-0000-0000-000000000001",
    "customer_id": "00000000-0000-0000-0000-000000000010",
    "amount_minor": 150000,
    "currency": "INR",
    "description": "Enterprise Subscription payment"
  }' | jq .
```
**Engineering Focus**: Exactly identical response is returned without creating a second record in PostgreSQL.

---

## 3. Payment State Machine Transitions (Minute 3)

### Transition: CREATED -> PENDING -> AUTHORIZED
```bash
# Initiate processing
curl -s -X POST "${BASE_URL}/api/v1/payments/${PAYMENT_ID}/initiate" | jq .

# Provider Authorize Hold
curl -s -X POST "${BASE_URL}/api/v1/payments/${PAYMENT_ID}/authorize" | jq .
```
**Engineering Focus**: The payment is now in `AUTHORIZED` status. No funds have moved in the double-entry ledger yet.

---

## 4. Payment Capture & Atomic Double-Entry Ledger Posting (Minute 4)

### Capture Payment
```bash
curl -s -X POST "${BASE_URL}/api/v1/payments/${PAYMENT_ID}/capture" \
  -H "Idempotency-Key: cap_${PAYMENT_ID}" | jq .
```
**Engineering Focus**:
1. Payment transitions to `CAPTURED`.
2. A balanced double-entry transaction was created atomically:
   - Debit: Merchant Settlement Receivable (+₹1500.00)
   - Credit: Platform Payment Clearing (+₹1500.00)
3. A `payment.captured` event was inserted into `outbox_events` in the same database transaction.

### Inspect Verified Balanced Ledger Entries
```bash
curl -s "${BASE_URL}/api/v1/ledger/transactions?referenceId=${PAYMENT_ID}" | jq .
```

### Verify System-Wide Ledger Invariants
```bash
curl -s "${BASE_URL}/api/v1/ledger/integrity" | jq .
```
**Engineering Focus**: Mathematical audit confirms $\sum \text{Debits} == \sum \text{Credits}$ across all journal lines with 0 orphan entries.

---

## 5. Webhook Ingestion, HMAC Verification & DLQ (Minute 5)

### Ingest Signed Provider Webhook
```bash
PAYLOAD='{"event_id":"evt_demo_99","event_type":"payment.captured","data":{"payment_id":"'${PAYMENT_ID}'","amount":150000,"currency":"INR"}}'
SECRET="ledgerx-webhook-secret-key-minimum-32-chars-for-hmac"
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -s -X POST "${BASE_URL}/api/v1/webhooks/mockpay" \
  -H "Content-Type: application/json" \
  -H "x-mockpay-signature: ${SIGNATURE}" \
  -d "${PAYLOAD}" | jq .
```
**Engineering Focus**: Timing-safe HMAC-SHA256 signature verification returns `202 Accepted` and streams to Kafka.

### Inspect DLQ Management
```bash
curl -s -H "x-admin-key: ${ADMIN_KEY}" "${BASE_URL}/api/v1/webhooks/dlq" | jq .
```

---

## 6. Compensating Partial Refund (Minute 6)

### Issue ₹500.00 Partial Refund
```bash
curl -s -X POST "${BASE_URL}/api/v1/payments/${PAYMENT_ID}/refund" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ref_${PAYMENT_ID}" \
  -d '{
    "amount_minor": 50000,
    "reason": "Customer requested partial return"
  }' | jq .
```
**Engineering Focus**:
1. Payment transitions to `PARTIALLY_REFUNDED`.
2. A compensating double-entry ledger transaction is posted:
   - Debit: Platform Payment Clearing (+₹500.00)
   - Credit: Merchant Settlement Receivable (+₹500.00)
3. Attempting to refund more than the remaining net captured amount (₹1000.00) will be strictly rejected with a `400 Bad Request` financial invariant error.

---

## 7. Financial Reconciliation (Minute 7)

### Trigger Automated Reconciliation Job
```bash
curl -s -X POST "${BASE_URL}/api/v1/reconciliation/run" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: ${ADMIN_KEY}" \
  -d '{
    "provider": "mockpay",
    "period_start": "2026-09-01T00:00:00Z",
    "period_end": "2026-09-30T23:59:59Z"
  }' | jq .
```

### Inspect Discrepancies
```bash
curl -s -H "x-admin-key: ${ADMIN_KEY}" \
  "${BASE_URL}/api/v1/reconciliation/discrepancies" | jq .
```
**Engineering Focus**: Deterministic matching compares reference IDs, amounts, and statuses. Discrepancies are isolated with audit logs without blocking other payments.

---

## 8. Settlement Batch Execution (Minute 8)

### Create Settlement Batch for Merchant
```bash
curl -s -X POST "${BASE_URL}/api/v1/settlements/batches" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: ${ADMIN_KEY}" \
  -d '{
    "merchant_id": "00000000-0000-0000-0000-000000000001",
    "period_start": "2026-09-01T00:00:00Z",
    "period_end": "2026-09-30T23:59:59Z"
  }' | jq .
```
Copy returned batch ID into `BATCH_ID`:
```bash
BATCH_ID="<COPIED_BATCH_ID>"
```

### Process Settlement Batch
```bash
curl -s -X POST "${BASE_URL}/api/v1/settlements/batches/${BATCH_ID}/process" \
  -H "x-admin-key: ${ADMIN_KEY}" | jq .
```
**Engineering Focus**:
1. Eligible captured transactions transition from `CAPTURED` to `SETTLED`.
2. Settlement payout journal entry posted to double-entry ledger:
   - Debit: Merchant Settlement Payable (Liability)
   - Credit: Merchant Bank Clearing (Asset)
3. Total settlement amount matches net captured minus refunds.

---

## 9. Production Engineering Dashboard (Minute 9)

Open your browser to:
```
http://localhost:3000
```
**Demonstrate**:
1. Real-time Payment Metrics (Volumes, GMV, Success vs Failure breakdown).
2. Live Double-Entry Ledger view with debits and credits balancing to zero.
3. System Health indicator reflecting live PostgreSQL, Redis, and Kafka connection states.
4. Reconciliation Discrepancy management table with status filtering.
5. Settlement batches table showing net payout amounts.

---

## 10. Graceful Shutdown & Drain Demonstration (Minute 10)

Send `SIGTERM` or `Ctrl+C` to the backend process:
```bash
# In another terminal:
curl -s "${BASE_URL}/ready" | jq .
```
**Engineering Focus**:
1. Server sets draining flag: `/ready` immediately returns HTTP 503 (`status: "SHUTTING_DOWN"`), allowing upstream load balancers to redirect traffic.
2. In-flight requests complete cleanly.
3. Kafka consumers and outbox worker finish current batch and pause.
4. Redis connections, Kafka clients, and PostgreSQL connection pool close gracefully.
5. Process exits cleanly with code 0 without orphaned financial transactions.
