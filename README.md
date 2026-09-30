LedgerX is a payment infrastructure and financial reconciliation platform that models reliable payment processing, double-entry accounting, risk evaluation, webhook handling, and automated settlement workflows.

It is designed around financial correctness and distributed-systems principles, including double-entry bookkeeping, idempotency, concurrency control, asynchronous event processing, reconciliation, and observability.

Note: LedgerX is an infrastructure sandbox and engineering platform. It does not process real-world monetary transactions directly. Real payment processing would require integration with an external payment provider.

---

## 1. Project Overview

LedgerX models the core backend infrastructure behind a modern payment service provider (PSP) and clearinghouse. In distributed financial architectures, operations cannot rely on simple database updates; they require fault-tolerant protocols that prevent double-crediting, enforce auditability, and ensure consistency across asynchronous boundaries.

Key capabilities modeled within the platform:
- **Payment Lifecycle Management**: Deterministic state machine governing transactions from initiation through authorization, capture, partial/full refunds, and settlement.
- **Double-Entry Bookkeeping**: Strict balance verification ($\sum \text{Debits} = \sum \text{Credits}$) with immutable journal entries and zero floating-point arithmetic.
- **Authoritative Idempotency**: Distributed request deduplication preventing duplicate charges across network retries.
- **Risk Evaluation Engine**: Synchronous pre-authorization risk scoring and velocity analysis.
- **Asynchronous Event Streaming**: Transactional Outbox pattern paired with Apache Kafka for guaranteed at-least-once domain event dispatch.
- **Signed Webhook Ingestion & DLQ**: Cryptographically signed event delivery with exponential backoff and dead-letter queue routing.
- **Multi-Source Reconciliation**: Automated matching engine reconciling internal ledger entries with external bank/gateway clearing files.
- **Batch Settlement Engine**: Net merchant payout calculation with automated double-entry ledger posting.
- **Production Observability**: Structured JSON logging, correlation ID tracing, and Prometheus metrics.

---

## 2. System Architecture

```text
                               LedgerX
                                  ↓
                             API Gateway
                                  ↓
             ┌─────────────────────────────────────────┐
             │ Payment Service                         │
             │ Ledger Service                          │
             │ Risk Engine                             │
             └─────────────────────────────────────────┘
                                  ↓
                             PostgreSQL
                                  ↓
                     Redis / Transactional Outbox
                                  ↓
                                Kafka
                                  ↓
             ┌─────────────────────────────────────────┐
             │ Webhook Processor                       │
             │ Reconciliation Engine                   │
             │ Settlement Engine                       │
             └─────────────────────────────────────────┘
                                  ↓
                         DLQ / Observability
```

---

## 3. Core Engineering Features

| Capability | Implementation |
| :--- | :--- |
| **Payment State Machine** | Validates forward and terminal payment states to prevent invalid financial state transitions. |
| **Double-Entry Ledger** | Enforces balanced ledger postings ($\sum \text{Debits} = \sum \text{Credits}$) using integer minor units. |
| **Authoritative Idempotency** | Prevents duplicate mutation requests using deterministic SHA-256 hashing and atomic record locking. |
| **Partial Refunds** | Tracks cumulative captured vs. refunded amounts to prevent over-refunding payment principals. |
| **Distributed Caching (Redis)** | Caches payment states and ledger account lookups with automated cache-aside invalidation. |
| **Distributed Locking (Redis)** | Coordinates concurrent operations across payment captures and refunds to prevent race conditions. |
| **Sliding-Window Rate Limiter** | Throttles excessive API traffic using atomic Redis Lua sliding-window counters. |
| **Event Streaming (Kafka)** | Decouples asynchronous domain events across dedicated partition-keyed topics. |
| **Transactional Outbox** | Atomically stages events inside database transactions to ensure at-least-once message publication. |
| **Signed Webhook Ingestion** | Validates webhook authenticity using HMAC-SHA256 signatures before processing payloads. |
| **Retry & Dead-Letter Queue** | Manages failed webhook events with exponential backoff, jitter, and dead-letter escalation. |
| **Risk Evaluation Engine** | Scores transactions against configurable velocity and heuristic fraud rules prior to authorization. |
| **Financial Reconciliation** | Matches internal records against external provider settlement reports across 8 discrepancy classifications. |
| **Automated Settlement** | Computes net merchant payouts and generates balanced double-entry ledger settlement postings. |
| **Observability & Metrics** | Exposes structured JSON logs, correlation tracking (`x-correlation-id`), and Prometheus metrics. |
| **Containerization (Docker)** | Encapsulates app services, PostgreSQL, Redis, and Kafka in reproducible environments. |
| **Automated CI/CD Pipeline** | Validates Prisma migrations, strict TypeScript compilation, and 225 unit/integration tests on every push. |

---

## 4. Payment Lifecycle

Payment state transitions are strictly governed by [PaymentStateMachine](src/modules/payments/payment-state-machine.ts). Any invalid transition attempt throws an `InvalidStateTransitionError` and is rejected at the API boundary.

```text
                  CREATED
                 ┌───┴───┐
                 ↓       ↓
             PENDING   FAILED
            ┌────┼─────────┐
            ↓    ↓         ↓
   AUTHORIZED  FAILED  CANCELLED
        ├───┐
        ↓   ↓
  CAPTURED CANCELLED
    ┌───┼────────────────────┐
    │   ↓                    ↓
    │ PARTIALLY_REFUNDED  REFUND_PENDING
    │   │                    ↓
    │   └────────────────> REFUNDED
    ↓
 SETTLED
```

### Supported Payment States

| Status | Category | Description |
| :--- | :--- | :--- |
| `CREATED` | Initial | Payment entity initialized with validated amount, currency, merchant, and customer. |
| `PENDING` | Active | Payment processing initiated with payment provider or payment method. |
| `AUTHORIZED` | Active | Funds reserved at cardholder institution; awaiting capture. |
| `CAPTURED` | Settling | Funds captured; triggers double-entry ledger capture entry. |
| `PARTIALLY_REFUNDED` | Active | One or more partial refunds posted; cumulative refund is less than captured amount. |
| `REFUND_PENDING` | Terminal / Transition | Full refund initiated; awaiting processor settlement. |
| `REFUNDED` | Terminal | Full principal amount refunded; balanced compensating ledger entry posted. |
| `SETTLED` | Terminal | Payment included in a reconciled settlement batch and disbursed to merchant. |
| `CANCELLED` | Terminal | Payment voided prior to capture; no ledger movement. |
| `FAILED` | Terminal | Payment attempt failed or rejected by risk engine. |

---

## 5. Financial Correctness & Double-Entry Accounting

LedgerX models double-entry accounting in accordance with standard financial principles: every financial event creates at least two offsetting journal entries.

$$\sum \text{Debits} = \sum \text{Credits}$$

### Accounting Invariants
1. **Zero Floating-Point Arithmetic**: All amounts are represented strictly in integer minor units (`amountMinor` as `bigint` in TypeScript, mapped to `BIGINT` in PostgreSQL) to eliminate IEEE 754 precision errors.
2. **Append-Only Immutability**: Historical entries are append-only. No `UPDATE` or `DELETE` operations are executed against ledger entries. Corrections require balanced compensating transactions.
3. **Normal Account Balances**:
   - **Asset & Expense Accounts**: Debit normal ($\text{Balance} = \text{Debits} - \text{Credits}$)
   - **Liability, Equity, Revenue & Clearing Accounts**: Credit normal ($\text{Balance} = \text{Credits} - \text{Debits}$)
4. **Reference Uniqueness**: Database-level unique constraint `(reference_type, reference_id)` prevents accidental duplicate postings for the same business event.

### Example Journal Entries

#### 1. Payment Capture (₹500.00 / 50000 paise)
When a payment is captured, the platform records merchant receivables against platform payment clearing:
```text
Transaction Type: CAPTURE
Reference: PAYMENT:<payment_id>

  DEBIT   MERCHANT_SETTLEMENT_RECEIVABLE (Asset)     50,000 INR
  CREDIT  PAYMENT_CLEARING               (Clearing)  50,000 INR
```

#### 2. Payment Refund (₹200.00 / 20000 paise)
When a refund is processed, a balanced compensating transaction reverses the receivable:
```text
Transaction Type: REFUND
Reference: REFUND:<refund_id>

  DEBIT   PAYMENT_CLEARING               (Clearing)  20,000 INR
  CREDIT  MERCHANT_SETTLEMENT_RECEIVABLE (Asset)     20,000 INR
```

#### 3. Settlement Payout (₹300.00 / 30000 paise net)
When funds are disbursed to the merchant bank account:
```text
Transaction Type: SETTLEMENT
Reference: SETTLEMENT:<batch_id>

  DEBIT   SETTLEMENT_CLEARING            (Clearing)  30,000 INR
  CREDIT  MERCHANT_SETTLEMENT_RECEIVABLE (Asset)     30,000 INR
```

---

## 6. Authoritative Idempotency

To protect financial APIs from duplicate charges due to network disconnects or client retries, state-mutating requests accept an `Idempotency-Key` header.

```text
Client sends Idempotency-Key
             ↓
LedgerX checks existing record
             ↓
      Already processed?
         ┌───┴───┐
        YES      NO
         ↓       ↓
   Return cached Acquire atomic lock
   HTTP response   (status: IN_PROGRESS)
                 ↓
           Process business logic
                 ↓
           Store HTTP response & payload hash
                 ↓
           Return response to client
```

### Protocol Mechanics
- **Deterministic Payload Hashing**: The request method, path, and normalized body are hashed via SHA-256 (`request_hash`). If an existing key is received with a mismatched payload, the server returns `409 Conflict (IDEMPOTENCY_KEY_REUSED)`.
- **Concurrent Request Protection**: If a secondary request arrives while the first is still `IN_PROGRESS`, the server returns `409 Conflict` to prevent simultaneous duplicate executions.
- **Replay Guarantee**: Once `COMPLETED`, identical retried requests receive the exact original response along with the header `x-idempotency-replayed: true`.

---

## 7. Event-Driven Processing & Transactional Outbox

To prevent dual-write vulnerabilities between PostgreSQL and Apache Kafka, LedgerX uses the **Transactional Outbox Pattern**:

```text
API Request / Mutation
          ↓
┌─────────────────────────────────────────┐
│ PostgreSQL Transaction Boundary         │
│  ├── 1. Mutate Domain Entities          │
│  └── 2. Insert Outbox Event (Pending)   │
└─────────────────────────────────────────┘
          ↓ Commit
Transactional Outbox Table
          ↓ Polling Publisher (outbox-worker.ts)
Apache Kafka Topic
          ↓ Partition-Keyed Consumer
Downstream Asynchronous Consumers
(Webhook Processor, Risk Evaluation, Reconciliation)
```

### Kafka Topic Partitioning

| Topic | Partition Key | Purpose |
| :--- | :--- | :--- |
| `ledgerx.payment.events` | `payment_id` | Payment lifecycle transitions (authorized, captured, failed). |
| `ledgerx.refund.events` | `payment_id` | Refund initiations and completions. |
| `ledgerx.settlement.events`| `batch_id` | Settlement batch readiness and completion events. |
| `ledgerx.webhook.events` | `webhook_id` | Ingested provider webhook events queued for async processing. |
| `ledgerx.webhook.dlq` | `webhook_id` | Dead-lettered events exceeding max retry attempts. |

---

## 8. Webhook Processing & Dead-Letter Queue (DLQ)

LedgerX ingests signed webhooks from external payment providers, validates payloads, and processes updates asynchronously.

```text
Incoming Webhook
       ↓
HMAC-SHA256 Signature Verification
       ↓ Valid
Check Deduplication Store
       ↓ New Event
Persist Event (RECEIVED)
       ↓
Publish to Kafka (ledgerx.webhook.events)
       ↓
Async Webhook Consumer
       ↓
Process Payment State Transition
       ├── SUCCESS: Mark PROCESSED
       └── FAILURE:
              ├── Retry with Exponential Backoff + Jitter (< max retries)
              └── Max Retries Exceeded: Escalate to Dead-Letter Queue (DLQ)
```

### Dead-Letter Queue Management
Failed events routed to the DLQ (`ledgerx.webhook.dlq`) preserve full diagnostic context: original payload, error messages, and retry count. Operators can inspect and replay DLQ events via administrative endpoints once root causes are resolved.

---

## 9. Multi-Source Financial Reconciliation

The reconciliation engine identifies discrepancies between LedgerX internal payment records and external clearing/settlement files provided by acquiring banks or payment gateways.

```text
Internal Payment Records       External Clearing Records
           \                               /
            \                             /
             ↓                           ↓
            ┌─────────────────────────────┐
            │ Reconciliation Match Engine │
            └─────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│ Discrepancy Categorization                                     │
│  ├── MATCHED: Identical status, reference, and minor amount    │
│  ├── AMOUNT_MISMATCH: Captured amounts differ                  │
│  ├── STATUS_MISMATCH: Internal vs. external status conflict     │
│  ├── MISSING_INTERNAL: External charge has no local record     │
│  ├── MISSING_EXTERNAL: Internal payment missing from gateway   │
│  ├── DUPLICATE_EXTERNAL: Multiple external records for charge  │
│  ├── DUPLICATE_INTERNAL: Multiple internal records for charge  │
│  └── CURRENCY_MISMATCH: Mismatched transaction currencies      │
└────────────────────────────────────────────────────────────────┘
                           ↓
         Discrepancy Investigation & Resolution
           (OPEN → INVESTIGATING → RESOLVED / WAIVED)
```

---

## 10. Settlement Batching & Calculation

Settlement batches aggregate eligible captured payments within a specific merchant processing window, deduct fees, apply adjustments, and generate net payouts.

### Net Settlement Calculation Formula

$$\text{Net Amount} = \text{Gross Captured} - \text{Refunds} - \text{Fees} + \text{Adjustments}$$

Calculated strictly in integer minor units:
$$\text{Item Fee} = \left\lfloor \frac{\text{Captured Amount} \times \text{Fee Bps}}{10000} \right\rfloor$$

```text
Select Eligible Transactions (Merchant + Currency + Date Window)
                           ↓
Exclude Already Settled or Open-Discrepancy Payments
                           ↓
Calculate Batch Gross, Refunds, Platform Fees & Net Total
                           ↓
Transition Batch Status: PENDING → PROCESSING → RECONCILED → READY
                           ↓
Execute Payout & Post Balanced Double-Entry Ledger Transaction
                           ↓
Mark Batch & Included Records as SETTLED
```

---

## 11. Observability & Operational Health

LedgerX exposes comprehensive operational telemetry for infrastructure monitoring:

- **Structured JSON Logging**: Every log entry includes ISO timestamps, log level, module name, and execution metrics via Winston.
- **Trace Context Propagation**: Every request carries an `x-correlation-id` and `x-request-id` header across internal services and Kafka messages.
- **Prometheus Metrics Endpoint**: Exposes HTTP request rates, latency histograms, ledger posting counts, and Kafka consumer lag via `GET /metrics`.
- **Health Probes**:
  - `GET /health`: Basic service liveness.
  - `GET /ready`: Readiness probe verifying PostgreSQL and Redis connections.
  - `GET /live`: Container liveness check for Kubernetes/orchestration.
- **Graceful Shutdown**: Intercepts `SIGTERM` and `SIGINT` signals to flush database pools, commit Kafka consumer offsets, and disconnect Redis clients without dropping active requests.

---

## 12. Testing & CI Pipeline

LedgerX enforces rigorous automated testing to prevent financial regression across code changes.

```text
Lint, Test & Build Workflow (.github/workflows/ci.yml)
  ├── 1. Initialize PostgreSQL 16 & Redis 7 Service Containers
  ├── 2. Setup Node.js 20 & Cache npm Dependencies
  ├── 3. Validate Prisma Schema (npx prisma validate)
  ├── 4. Generate Prisma Client (npx prisma generate)
  ├── 5. Run Prisma Migrations (npx prisma migrate deploy)
  ├── 6. Strict TypeScript Typecheck & Lint (npm run lint)
  ├── 7. Full Test Suite: Unit, Integration & E2E (npm test)
  ├── 8. Build Production TypeScript Bundle (npm run build)
  └── 9. Verify Public Dashboard Assets
```

**Test Verification Status**:
- **19 Test Suites** covering all modules
- **225 Automated Tests** passing with 0 failures
- Verification includes concurrency tests, double-entry invariance validations, idempotency replaying, and full 19-step end-to-end financial lifecycle verification.

---

## 13. Technology Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Runtime** | Node.js 20+ (ESM) | High-performance asynchronous execution environment. |
| **Language** | TypeScript 5.7 | Strict compile-time typing for financial correctness. |
| **Web Framework** | Express 4.21 | Lightweight API gateway and HTTP routing layer. |
| **Database** | PostgreSQL 16 | ACID-compliant relational store with foreign key constraints. |
| **Cache & Locking** | Redis 7 (`ioredis`) | In-memory distributed locking, sliding-window rate limiting, and cache-aside. |
| **Event Streaming** | Apache Kafka 3.x (`kafkajs`) | Partition-keyed distributed message bus for domain events. |
| **ORM / Migrations** | Prisma 5.22 | Declarative database schema, migrations, and type-safe query generation. |
| **Validation** | Zod 3.24 | Runtime schema validation for request inputs and environmental variables. |
| **Testing** | Vitest 2.1 & Supertest 7.0 | Unit, integration, and HTTP lifecycle testing framework. |
| **Frontend** | Vanilla HTML5, CSS3, JS | Zero-dependency operations console and infrastructure visualizer. |
| **Infrastructure** | Docker & Docker Compose | Containerized service orchestration for development and production. |
| **CI/CD** | GitHub Actions | Automated lint, migration verification, test execution, and compilation. |

---

## 14. Project Structure

```text
ledgerx/
├── .github/
│   └── workflows/
│       └── ci.yml               # GitHub Actions CI workflow definition
├── docker/
│   ├── docker-compose.dev.yml   # Multi-service local dev composition
│   └── docker-compose.prod.yml  # Production deployment composition
├── docs/
│   ├── architecture.md          # In-depth architectural design specification
│   ├── backup-recovery.md       # Database backup and disaster recovery runbook
│   ├── demo.md                  # Interactive platform verification guide
│   ├── openapi.yaml             # Complete OpenAPI 3.0 API specification
│   └── runbook.md               # Operational runbook and troubleshooting guide
├── prisma/
│   ├── schema.prisma            # Declarative database schema and models
│   └── migrations/              # Versioned SQL migration history
├── public/
│   ├── index.html               # Operations dashboard & telemetry UI
│   ├── favicon.svg              # Brand icon
│   └── brand/                   # Official SVG brand marks and logos
├── scripts/
│   ├── kafka-topics.ts          # Kafka topic provisioning script
│   ├── kafka-consume.ts         # Diagnostic Kafka stream consumer
│   ├── outbox-worker.ts         # Transactional outbox polling daemon
│   └── load-test.ts             # Concurrent payment load testing utility
├── src/
│   ├── common/                  # Shared errors, money arithmetic, and middleware
│   │   ├── middleware/          # Correlation, rate limiting, and error handlers
│   │   └── idempotency/         # Idempotency service and cryptographic hashing
│   ├── config/                  # Validated environment configuration (Zod)
│   ├── db/                      # Prisma client and database health probes
│   ├── infra/                   # Redis cache, distributed locks, Kafka producer/client
│   ├── modules/                 # Modular domain services
│   │   ├── dashboard/           # Metrics aggregation endpoints
│   │   ├── health/              # Liveness and readiness endpoints
│   │   ├── integration/         # Full end-to-end financial lifecycle tests
│   │   ├── ledger/              # Double-entry ledger service, repo, and container
│   │   ├── payments/            # Payment state machine, validation, and refunds
│   │   ├── reconciliation/      # External statement matching engine
│   │   ├── risk/                # Fraud assessment rules and risk engine
│   │   ├── settlements/         # Settlement calculation and batch processor
│   │   └── webhooks/            # HMAC verification, consumer, and DLQ repo
│   ├── index.ts                 # Application entrypoint & HTTP server listener
│   └── server.ts                # Express application factory & middleware chain
├── package.json                 # Project dependencies and script definitions
└── tsconfig.json                # Strict TypeScript compiler configuration
```

---

## 15. Running Locally

### Prerequisites
- Node.js 20.x or higher
- npm 10.x or higher
- Docker & Docker Compose (optional, for running local PostgreSQL/Redis/Kafka containers)

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/Daksh-2305/ledgerx.git
cd ledgerx
npm install
```

### 2. Configure Environment
Copy the example environment template:
```bash
cp .env.example .env
```
*(The defaults in `.env.example` point to standard local ports and in-memory mock fallbacks for standalone execution without required external containers).*

### 3. Start Infrastructure Dependencies (Optional)
If running with real PostgreSQL, Redis, and Kafka:
```bash
docker compose -f docker-compose.dev.yml up -d
```

### 4. Database Setup (When using PostgreSQL)
Generate Prisma client and run migrations:
```bash
npm run db:generate
npm run db:deploy
```

### 5. Launch the Platform
Start the development server with live reload:
```bash
npm run dev
```
The server will start at `http://localhost:3000`. Navigate to `http://localhost:3000` to interact with the LedgerX Operations Console.

### 6. Run the Test Suite
Execute all 19 test suites and 225 automated unit, integration, and E2E tests:
```bash
npm test
```

### 7. Run Typecheck & Build
Verify TypeScript compilation:
```bash
npm run lint
npm run build
```

---

## 16. Technical Documentation

Detailed operational and architectural documentation is available in the [`docs/`](docs/) directory:

- [Architectural Specification](docs/architecture.md) — Comprehensive technical design, concurrency controls, and failure recovery.
- [OpenAPI Specification](docs/openapi.yaml) — Complete OpenAPI 3.0 API schema and endpoint contracts.
- [Operations Runbook](docs/runbook.md) — Operational runbook, incident response protocols, and metric thresholds.
- [Platform Demo Guide](docs/demo.md) — Walkthrough instructions for testing the end-to-end financial lifecycle.
- [Backup & Disaster Recovery](docs/backup-recovery.md) — Backup procedures, point-in-time recovery, and data retention policies.

---

## 17. Dashboard & Operations Console

LedgerX includes a real-time, browser-based financial operations dashboard served directly from `public/index.html`. It provides administrative visibility into:

- **Executive Overview**: Real-time gross payment volume, net settlement totals, discrepancy counters, and throughput graphs.
- **Payments Management**: Payment creation, authorization, capture, and partial/full refund executions.
- **Double-Entry Ledger**: Real-time inspection of balanced journal entries and debit/credit ledger accounts.
- **Risk Assessment**: Heuristic scoring, rule evaluations, and allow/block decisions.
- **Reconciliation Console**: Multi-source file matching, status mismatch resolution, and discrepancy audits.
- **Settlement Batches**: Period batch generation, fee deductions, and ledger payout posting.

> *Note: UI demonstration assets can be viewed by running the application locally at `http://localhost:3000` or following the walkthrough in [docs/demo.md](docs/demo.md).*

---

## 18. Project Implementation Status

- [x] **Core Payment Lifecycle**: State machine transitions (`CREATED` → `SETTLED`) with validation rules.
- [x] **Double-Entry Ledger**: Balanced debit/credit posting with append-only transaction immutability.
- [x] **Idempotency Protocol**: SHA-256 deterministic request hashing with atomic record state locks.
- [x] **Partial & Full Refunds**: Dynamic principal tracking with over-refund prevention.
- [x] **Distributed Caching & Locks**: Redis-backed cache-aside and mutex coordination.
- [x] **Transactional Outbox**: Guaranteed event persistence prior to Kafka publishing.
- [x] **Asynchronous Event Processing**: Kafka partition-keyed domain message bus.
- [x] **Webhook Engine & DLQ**: HMAC-SHA256 signature validation with dead-letter queue escalation.
- [x] **Risk Evaluation Engine**: Pre-authorization velocity and heuristic fraud scoring.
- [x] **Financial Reconciliation**: Multi-source matching engine supporting 8 discrepancy classifications.
- [x] **Batch Settlement Engine**: Net payout calculation using integer minor unit math.
- [x] **Observability**: Prometheus metrics, health probes, structured logging, and correlation tracking.
- [x] **Automated CI/CD**: 100% green GitHub Actions pipeline running lint, migrations, and 225 tests.

---

## 19. License

This project is licensed under the Apache 2.0 License. See the [LICENSE](LICENSE) file for details.
