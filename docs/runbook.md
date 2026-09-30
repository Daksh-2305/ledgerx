# LedgerX Production Operational Runbook

This document defines standardized operational procedures and troubleshooting runbooks for the LedgerX payment infrastructure and financial reconciliation platform.

---

## Quick Reference Incident Triage

| Symptom | Primary Component | Health Probe | Priority |
| :--- | :--- | :--- | :--- |
| HTTP 502/504 Bad Gateway / Connection Refused | API Service / Container | `GET /health` | P1 |
| HTTP 503 Service Unavailable | PostgreSQL / Readiness Check | `GET /ready` | P1 |
| Redis Connection Refusal / Failover | Redis Sentinel / Cluster | `GET /health/dependencies` | P2 |
| Webhook or Async Event Delays | Kafka Broker / Consumers | `GET /health/dependencies` | P2 |
| Growing DLQ Records | Webhook Consumers / Workers | `GET /api/v1/webhooks/dlq` | P2 |
| Financial Discrepancies Spiking | Reconciliation Worker | `GET /api/v1/reconciliation/runs` | P1 |
| Settlement Batch Execution Failure | Settlement Engine | `GET /api/v1/settlements` | P1 |

---

## 1. API Unavailable (Process Down / Crash Loop)

### Symptoms
* Ingress load balancer / reverse proxy returns `502 Bad Gateway` or `504 Gateway Timeout`.
* Kubernetes or Docker restarts containers continuously (crash loop backoff).
* Monitoring alerts: `http_requests_total` rate drops to zero; health check fails.

### Possible Causes
* Missing mandatory production environment variables (`DATABASE_URL`, `JWT_SECRET`, `ADMIN_API_KEY`).
* Unhandled exception during startup or out-of-memory (OOM) killer invoked.
* Port collision or permissions issue when binding to `PORT`.

### Checks
```bash
# Check container status
docker-compose -f docker-compose.prod.yml ps

# Inspect recent crash logs
docker-compose -f docker-compose.prod.yml logs --tail 100 api

# Check memory and exit codes
docker inspect ledgerx-api --format='{{.State.ExitCode}} {{.State.OOMKilled}}'
```

### Recovery Steps
1. Verify required environment variables against `.env.example`:
   ```bash
   grep -v '^#' .env.prod | grep -E '(DATABASE_URL|REDIS_URL|KAFKA_BROKERS|JWT_SECRET|ADMIN_API_KEY)'
   ```
2. If OOM killed, increase container memory limits in `docker-compose.prod.yml` (e.g. from 1G to 2G) and inspect for memory leaks.
3. Restart container cleanly:
   ```bash
   docker-compose -f docker-compose.prod.yml restart api
   ```

### Verification
```bash
curl -i http://localhost:3000/health
# Expect: HTTP 200 OK {"status":"UP","service":"ledgerx-core"}
```

---

## 2. PostgreSQL Unavailable (Database Connection Exhaustion / Downtime)

### Symptoms
* All stateful endpoints return `503 Service Unavailable` with `dependencies.database: "DOWN"`.
* Logs contain `PrismaClientInitializationError` or `Timed out fetching a new connection from the pool`.
* `GET /ready` probe fails with HTTP 503.

### Possible Causes
* PostgreSQL service stopped or crashed.
* Connection pool exhaustion (max active connections exceeded).
* Host disk full on database volume.
* Network partition between application nodes and PostgreSQL.

### Checks
```bash
# Check PostgreSQL container
docker-compose -f docker-compose.prod.yml ps postgres

# Check active Postgres connections
docker exec -it ledgerx-postgres psql -U postgres -d ledgerx -c \
  "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

# Check available disk space
docker exec -it ledgerx-postgres df -h /var/lib/postgresql/data
```

### Recovery Steps
1. If PostgreSQL container stopped:
   ```bash
   docker-compose -f docker-compose.prod.yml start postgres
   ```
2. If connection pool exhausted, terminate idle or orphaned connections:
   ```sql
   SELECT pg_terminate_backend(pid) 
   FROM pg_stat_activity 
   WHERE state = 'idle' AND state_change < current_timestamp - INTERVAL '5 minutes';
   ```
3. Tune pool parameters in `.env`:
   ```env
   DATABASE_POOL_MAX=20
   DATABASE_CONNECTION_TIMEOUT_MS=5000
   ```
4. Restart application pods/containers.

### Verification
```bash
curl -i http://localhost:3000/ready
# Expect: HTTP 200 {"status":"UP","dependencies":{"database":"UP"}}
```

---

## 3. Redis Unavailable (Degraded Non-Authoritative State)

### Symptoms
* `GET /health/dependencies` reports `redis.status: "DOWN"` with warning logged.
* Cache misses spike; rate limiting automatically bypasses or uses local fail-safe counter.
* Velocity checks in Risk Engine fall back to conservative limits or pass-through.
* Note: PostgreSQL remains the financial source of truth; core ledger balances remain intact.

### Possible Causes
* Redis container stopped or out of memory (`maxmemory` policy reached without eviction).
* Misconfigured `REDIS_URL` or network partition.

### Checks
```bash
# Ping Redis
docker exec -it ledgerx-redis redis-cli ping

# Check Redis memory usage
docker exec -it ledgerx-redis redis-cli info memory
```

### Recovery Steps
1. Restart Redis instance:
   ```bash
   docker-compose -f docker-compose.prod.yml restart redis
   ```
2. If Redis is out of memory, flush volatile cache keys (financial data is NEVER stored solely in Redis):
   ```bash
   docker exec -it ledgerx-redis redis-cli --scan --pattern 'cache:*' | xargs redis-cli del
   ```
3. Verify Redis connection in application logs:
   ```bash
   docker-compose -f docker-compose.prod.yml logs api | grep -i redis
   ```

### Verification
```bash
curl -i http://localhost:3000/health/dependencies
# Expect: "redis":{"status":"UP","connected":true}
```

---

## 4. Kafka Unavailable / Broker Disconnect

### Symptoms
* Logs display `KafkaJSConnectionError` or `Request timed out after 30000ms`.
* Outbox events accumulate in `outbox_events` table with `status = 'PENDING'`.
* Asynchronous webhooks and risk processing stall.

### Possible Causes
* Kafka broker or Zookeeper/KRaft node failure.
* Network firewall blocking port 9092.
* Broker disk storage full.

### Checks
```bash
# Check Kafka container status
docker-compose -f docker-compose.prod.yml ps kafka

# Check pending transactional outbox events
docker exec -it ledgerx-postgres psql -U postgres -d ledgerx -c \
  "SELECT status, count(*) FROM outbox_events GROUP BY status;"
```

### Recovery Steps
1. Restart Kafka broker:
   ```bash
   docker-compose -f docker-compose.prod.yml restart kafka
   ```
2. Verify topics exist:
   ```bash
   npm run kafka:topics
   ```
3. Outbox worker will automatically resume publishing pending events from PostgreSQL once Kafka connectivity is restored (transactional outbox pattern guarantees no event loss).

### Verification
```bash
curl -i http://localhost:3000/health/dependencies
# Expect: "kafka":{"status":"UP","connected":true}
```

---

## 5. Consumer Stuck / Rebalance Loop

### Symptoms
* Kafka consumer group lag continuously increases (`kafka-consumer-groups.sh --describe`).
* Consumer logs display heartbeat timeouts or `CommitFailedException`.
* Outbox events marked PUBLISHED but consumers are not processing events.

### Possible Causes
* Consumer processing time exceeded `max.poll.interval.ms` (long-running batch).
* Unhandled exception causing repeated pod restarts without committing offsets.

### Checks
```bash
# Inspect consumer group lag
docker exec -it ledgerx-kafka kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group ledgerx-webhook-workers \
  --describe
```

### Recovery Steps
1. Inspect consumer logs for stuck worker threads:
   ```bash
   docker-compose -f docker-compose.prod.yml logs --tail 200 outbox-worker
   ```
2. Restart outbox and consumer workers:
   ```bash
   docker-compose -f docker-compose.prod.yml restart outbox-worker
   ```
3. If a poison message is crashing consumers, identify message offset and publish directly to Dead Letter Queue (DLQ).

### Verification
* Verify consumer lag decreases towards zero.

---

## 6. Dead-Letter Queue (DLQ) Growing

### Symptoms
* Prometheus metric `webhook_dlq_total` increasing.
* Admin dashboard displays pending DLQ events at `/api/v1/webhooks/dlq`.

### Possible Causes
* External provider sending malformed JSON payload.
* Invalid or rotated webhook signature secrets.
* Downstream payment provider API outage causing exhausted retries.

### Checks
```bash
# Query pending DLQ entries via Admin API
curl -H "x-admin-key: ${ADMIN_API_KEY}" \
  http://localhost:3000/api/v1/webhooks/dlq?status=PENDING
```

### Recovery Steps
1. Inspect the `last_error` field of DLQ items to distinguish data validation errors from transient errors.
2. If caused by transient failure or fixed provider issue, replay failed events:
   ```bash
   curl -X POST -H "x-admin-key: ${ADMIN_API_KEY}" \
     http://localhost:3000/api/v1/webhooks/dlq/replay-all
   ```
3. If caused by malformed/invalid payloads, mark them resolved with audit notes:
   ```bash
   curl -X POST -H "x-admin-key: ${ADMIN_API_KEY}" \
     -H "Content-Type: application/json" \
     -d '{"resolution_notes":"Invalid test webhook from provider"}' \
     http://localhost:3000/api/v1/webhooks/dlq/{eventId}/resolve
   ```

### Verification
* Verify DLQ pending count returns to 0.

---

## 7. Reconciliation Discrepancies Increasing

### Symptoms
* Metric `reconciliation_discrepancies_total` spiking.
* Reconciliation run finishes with status `COMPLETED_WITH_DISCREPANCIES`.
* Types: `AMOUNT_MISMATCH`, `STATUS_MISMATCH`, `MISSING_INTERNAL`, `MISSING_EXTERNAL`.

### Possible Causes
* Currency conversion timing or fee deduction not reflected in settlement report.
* Unprocessed webhook events causing internal payment to remain in `AUTHORIZED` while provider has captured it.
* Timezone mismatch in external settlement file cut-off windows.

### Checks
```bash
# Review recent discrepancy breakdown
docker exec -it ledgerx-postgres psql -U postgres -d ledgerx -c \
  "SELECT discrepancy_type, status, count(*) FROM reconciliation_discrepancies GROUP BY discrepancy_type, status;"
```

### Recovery Steps
1. For `STATUS_MISMATCH`: Check if external payment captured but webhook was delayed; trigger manual status sync or webhook replay.
2. For `AMOUNT_MISMATCH`: Inspect if provider fees were deducted from gross amount. Adjust settlement parsing or post fee journal entries.
3. For unresolved legitimate discrepancies: Mark under investigation and resolve via Reconciliation API:
   ```bash
   curl -X POST -H "x-admin-key: ${ADMIN_API_KEY}" \
     -H "Content-Type: application/json" \
     -d '{"notes":"Provider fee confirmed by finance team","action":"ADJUSTED"}' \
     http://localhost:3000/api/v1/reconciliation/discrepancies/{discrepancyId}/resolve
   ```

### Verification
* Run subsequent reconciliation job over the period:
  ```bash
  curl -X POST -H "x-admin-key: ${ADMIN_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"provider":"mockpay","period_start":"2026-09-01T00:00:00Z","period_end":"2026-09-30T23:59:59Z"}' \
    http://localhost:3000/api/v1/reconciliation/run
  ```

---

## 8. Settlement Failures

### Symptoms
* Settlement batch enters `FAILED` state.
* Merchant settlement payouts fail to post to double-entry ledger.
* `settlement_failures_total` metric increases.

### Possible Causes
* Merchant settlement account inactive or invalid currency.
* Insufficient merchant unsettled funds balance.
* Ledger invariant violation (e.g. unbalanced debit/credit attempt).

### Checks
```bash
# Query failed settlement batches
docker exec -it ledgerx-postgres psql -U postgres -d ledgerx -c \
  "SELECT id, merchant_id, status, total_amount_minor, error_message FROM settlement_batches WHERE status = 'FAILED';"
```

### Recovery Steps
1. Check merchant ledger accounts:
   ```bash
   curl http://localhost:3000/api/v1/ledger/accounts?merchant_id={merchantId}
   ```
2. Inspect failure reason in `error_message`.
3. If failure was due to transient locking or transient concurrency: retry settlement batch execution.
4. If ledger integrity invariant blocked the batch, review entries to ensure debit equals credit.

### Verification
* Verify batch status transitions to `COMPLETED` and settlement ledger transaction is posted with net zero sum balance.

---

## 9. High Payment Failure Rate Spike

### Symptoms
* `payment_failed_total` rate surges relative to `payment_created_total`.
* Error spikes on `POST /api/v1/payments/{id}/authorize` or `/capture`.

### Possible Causes
* Upstream payment gateway outage or elevated card network decline rates.
* Invalid merchant credentials or suspended merchant account.
* Database deadlock on high-concurrency balance updates.

### Checks
```bash
# Check failure breakdown by reason
docker exec -it ledgerx-postgres psql -U postgres -d ledgerx -c \
  "SELECT error_code, count(*) FROM payments WHERE status = 'FAILED' AND created_at > current_timestamp - INTERVAL '1 hour' GROUP BY error_code;"
```

### Recovery Steps
1. If provider is rejecting traffic: check provider status page and route traffic to secondary processor if multi-provider failover is active.
2. If localized to a specific merchant: verify merchant KYC and status in database:
   ```bash
   curl http://localhost:3000/api/v1/merchants/{merchantId}
   ```

---

## 10. High-Risk Payment Spike / Fraud Attack

### Symptoms
* Metric `blocked_payments_total` or `review_payments_total` rises rapidly.
* Rapid succession of payments from identical IP addresses or single card fingerprints.

### Possible Causes
* Card testing or brute-force velocity attack targeting checkout endpoints.
* Compromised customer accounts.

### Checks
```bash
# Inspect velocity counters in Redis
docker exec -it ledgerx-redis redis-cli --scan --pattern 'risk:velocity:*'

# Check recent risk assessments
docker exec -it ledgerx-postgres psql -U postgres -d ledgerx -c \
  "SELECT decision, score, count(*) FROM risk_assessments WHERE created_at > current_timestamp - INTERVAL '30 minutes' GROUP BY decision, score;"
```

### Recovery Steps
1. Adjust rate limiting window and limits via environment or Redis:
   ```env
   RATE_LIMIT_MAX_REQUESTS=50
   RATE_LIMIT_WINDOW_SECS=60
   ```
2. Enable stricter risk rule thresholds in `src/modules/risk/risk.rules.ts`.
3. Blacklist malicious CIDR blocks at the reverse proxy/firewall layer.

---

## 11. Database Migration Failure

### Symptoms
* Application crashes on deployment during `prisma migrate deploy`.
* Error logs report `Migration failed to apply cleanly` or lock acquisition failure.

### Possible Causes
* Schema conflict between concurrent deployment processes.
* Table lock timeout on heavily utilized tables (`payments`, `ledger_entries`).
* Migration contains non-reproducible manual changes.

### Checks
```bash
# Check migration status table
docker exec -it ledgerx-postgres psql -U postgres -d ledgerx -c \
  "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;"
```

### Recovery Steps
1. Mark the failed migration resolved or rolled back in Prisma:
   ```bash
   npx prisma migrate resolve --rolled-back "20260901000000_init"
   ```
2. If a migration is locked due to an uncommitted transaction:
   ```sql
   SELECT pid, query, state, age(clock_timestamp(), query_start) 
   FROM pg_stat_activity 
   WHERE query ILIKE '%ALTER TABLE%' OR query ILIKE '%CREATE INDEX%';
   ```
3. Terminate blocking lock and re-run migration:
   ```bash
   npx prisma migrate deploy
   ```

### Verification
```bash
npx prisma migrate status
# Expect: "Database schema is up to date!"
```
