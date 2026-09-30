# LedgerX Architecture Specification

## 1. System Overview

LedgerX is a mission-critical payment infrastructure and automated financial reconciliation platform designed with double-entry accounting correctness, deterministic reconciliation, strict idempotency, transactional outbox messaging, and distributed fault tolerance.

### 1.1 Architecture Diagram

```mermaid
graph TD
    Client[API Client / Dashboard] -->|HTTP / REST + JSON| Ingress[API Gateway :3000]
    
    subgraph "Core API Service"
        Ingress --> Correlation[Correlation & Tracing Middleware]
        Correlation --> RateLimiter[Rate Limiter & Auth]
        RateLimiter --> PayController[Payment Controller]
        RateLimiter --> LedgerController[Ledger Controller]
        RateLimiter --> WebhookController[Webhook Controller]
        RateLimiter --> ReconController[Reconciliation Controller]
        RateLimiter --> SettleController[Settlement Controller]
        RateLimiter --> HealthMetrics[Health & Prometheus Metrics]
    end

    subgraph "Data Storage & In-Memory Tier"
        Postgres[(PostgreSQL 16<br/>Financial Source of Truth<br/>MVCC + Row-Level Locks)]
        Redis[(Redis 7<br/>Distributed Locks, Cache<br/>Rate Limiting, Velocity)]
        Kafka[(Apache Kafka 3.7<br/>Transactional Event Bus)]
    end

    PayController -->|ACID Transactions| Postgres
    PayController -->|Distributed Locks & Velocity| Redis
    PayController -->|Transactional Outbox| Postgres

    LedgerController -->|Balanced Journal Entries| Postgres

    subgraph "Asynchronous Background Workers"
        OutboxWorker[Transactional Outbox Worker]
        WebhookWorker[Webhook Ingestion & DLQ Consumer]
        RiskWorker[Rule-Based Risk Evaluator]
        ReconWorker[Automated Reconciliation Engine]
        SettlementWorker[Settlement Batch Processor]
    end

    Postgres -->|Poll PENDING Events| OutboxWorker
    OutboxWorker -->|Publish Events| Kafka
    Kafka -->|Topic: ledgerx.payment.events| RiskWorker
    Kafka -->|Topic: ledgerx.webhook.events| WebhookWorker
    WebhookWorker -->|DLQ on Exhaustion| Postgres
    ReconWorker -->|Compare Internal vs Provider| Postgres
    SettlementWorker -->|Payout Journal Posting| Postgres
```

---

## 2. Payment Lifecycle & State Machine

Payments advance through a deterministic, strictly validated finite state machine.

### 2.1 State Transitions

```mermaid
stateDiagram-v2
    [*] --> CREATED: Payment Request Initiated
    CREATED --> PENDING: Gateway Processing Initiated
    CREATED --> CANCELLED: Customer Abandons
    PENDING --> AUTHORIZED: Provider Confirms Hold
    PENDING --> FAILED: Provider Declines / Risk Block
    AUTHORIZED --> CAPTURED: Capture Triggered + Balanced Ledger Posted
    AUTHORIZED --> CANCELLED: Authorization Voided
    CAPTURED --> REFUND_PENDING: Compensating Refund Initiated
    CAPTURED --> SETTLED: Included in Processed Settlement Batch
    REFUND_PENDING --> PARTIALLY_REFUNDED: Partial Refund Settled
    REFUND_PENDING --> REFUNDED: Full Refund Settled
    PARTIALLY_REFUNDED --> REFUND_PENDING: Additional Refund Initiated
    PARTIALLY_REFUNDED --> SETTLED: Remaining Net Amount Settled
    FAILED --> [*]
    CANCELLED --> [*]
    REFUNDED --> [*]
    SETTLED --> [*]
```

### 2.2 Payment Capture & Double-Entry Ledger Coordination

When a payment is captured (`POST /api/v1/payments/:id/capture`):
1. **Pessimistic Row-Level Lock**: PostgreSQL `SELECT ... FOR UPDATE` row locks serialize concurrent capture attempts.
2. **State Verification**: Asserts current status is `AUTHORIZED`.
3. **Double-Entry Journal Entry Generation**:
   - Debit: Merchant Settlement Receivable (Asset account) `+Amount`
   - Credit: Platform Payment Clearing (Clearing account) `+Amount`
4. **Invariant Check**: $\sum \text{Debits} = \sum \text{Credits}$ verified before commit.
5. **Transactional Outbox Event**: `payment.captured` event inserted into `outbox_events` in the same database transaction.

---

## 3. Double-Entry Accounting Core

Financial transactions in LedgerX strictly conform to classic double-entry bookkeeping:

```mermaid
sequenceDiagram
    autonumber
    actor Merchant as Merchant / Client
    participant API as Payment Service
    participant DB as PostgreSQL Transaction
    participant Ledger as Ledger Engine
    participant Outbox as Outbox Table

    Merchant->>API: POST /api/v1/payments/:id/capture
    API->>DB: BEGIN TRANSACTION (SERIALIZABLE / READ COMMITTED)
    API->>DB: SELECT * FROM payments WHERE id = :id FOR UPDATE
    Note over DB: Verify state is AUTHORIZED
    API->>Ledger: Generate Journal Entries
    Note over Ledger: Verify sum(Debits) == sum(Credits)
    Ledger->>DB: INSERT INTO ledger_transactions (id, type, reference_id)
    Ledger->>DB: INSERT INTO ledger_entries (debit/credit lines)
    API->>DB: UPDATE payments SET status = 'CAPTURED'
    API->>Outbox: INSERT INTO outbox_events (event_type, payload)
    DB->>API: COMMIT TRANSACTION
    API-->>Merchant: HTTP 200 OK (Payment Captured)
```

### Double-Entry Invariants
1. **Balance Invariant**:
   $$\sum \text{Debits} = \sum \text{Credits}$$
   Every transaction requires at least 2 entries. If total debits do not equal total credits, the transaction fails and rolls back completely with `FinancialInvarianceError`.
2. **Append-Only Immutability**:
   Historical ledger entries and transactions are immutable. No `UPDATE` or `DELETE` operations are exposed. Financial corrections require a new compensating transaction.
3. **Reference Uniqueness**:
   A PostgreSQL unique constraint `UNIQUE (reference_type, reference_id)` on `ledger_transactions` ensures one financial event (such as a payment capture) can never post duplicate ledger transactions.
4. **Positive Amounts**:
   All entries enforce `amount_minor > 0` at both application and database level (`CHECK (amount_minor > 0)`).

---

## 4. Asynchronous Event Flow & Transactional Outbox

To guarantee reliable messaging without dual-write consistency issues, LedgerX implements the **Transactional Outbox Pattern**.

```mermaid
sequenceDiagram
    autonumber
    participant App as Application Core
    participant DB as PostgreSQL (outbox_events)
    participant Worker as Outbox Worker
    participant Kafka as Kafka Broker (Topics)
    participant Consumer as Downstream Consumers (Risk / Webhook)

    App->>DB: Atomically commit business mutation + outbox_events (status: PENDING)
    loop Outbox Polling Loop
        Worker->>DB: SELECT * FROM outbox_events WHERE status = 'PENDING' FOR UPDATE SKIP LOCKED
        Worker->>Kafka: Publish event with correlation_id & partition key
        Kafka-->>Worker: Ack (RecordMetadata: topic, partition, offset)
        Worker->>DB: UPDATE outbox_events SET status = 'PUBLISHED', published_at = NOW()
    end
    Kafka->>Consumer: Deliver event (At-Least-Once)
    Consumer->>Consumer: Execute idempotent business logic
    Consumer->>Kafka: Commit offset
```

---

## 5. Webhook Ingestion, Retries & Dead-Letter Queue (DLQ)

```mermaid
sequenceDiagram
    autonumber
    actor Gateway as External Provider (MockPay)
    participant API as Webhook Ingestion API
    participant Kafka as Kafka Event Topic
    participant Consumer as Webhook Consumer
    participant DLQ as Dead-Letter Queue Table

    Gateway->>API: POST /api/v1/webhooks/mockpay (Payload + HMAC Header)
    API->>API: Verify HMAC-SHA256 Timing-Safe Signature
    alt Invalid Signature
        API-->>Gateway: HTTP 401 Unauthorized
    else Valid Signature
        API->>Kafka: Publish to ledgerx.webhook.events
        API-->>Gateway: HTTP 202 Accepted { received: true }
    end

    Kafka->>Consumer: Consume Webhook Event
    alt Processing Fails (Transient Error)
        Consumer->>Consumer: Exponential Backoff Retry (Max 5 attempts)
    else Exhausted Retries / Poison Message
        Consumer->>DLQ: Write to webhook_dlq (status: PENDING, last_error)
        Consumer->>Kafka: Commit offset
    end
```

---

## 6. Automated Financial Reconciliation Flow

The reconciliation engine detects discrepancies between LedgerX internal records and external provider settlement files.

```mermaid
flowchart TD
    A[External Settlement File / API] -->|Import Records| B[reconciliation_external_records]
    C[LedgerX Internal Payments] -->|Query Window| D[reconciliation_internal_records]
    
    B --> E{Deterministic Matching Engine}
    D --> E
    
    E -->|Exact Match: Reference, Amount, Status| F[Match Status: MATCHED]
    E -->|Status Differs| G[Discrepancy: STATUS_MISMATCH]
    E -->|Amount Differs| H[Discrepancy: AMOUNT_MISMATCH]
    E -->|Found in Internal only| I[Discrepancy: MISSING_EXTERNAL]
    E -->|Found in External only| J[Discrepancy: MISSING_INTERNAL]
    
    G --> K[Reconciliation Run Summary]
    H --> K
    I --> K
    J --> K
    F --> K
    K --> L[Generate Discrepancy Action Items]
```

---

## 7. Settlement & Settlement Batch Execution Flow

```mermaid
sequenceDiagram
    autonumber
    actor Merchant as Merchant / Admin
    participant Settle as Settlement Engine
    participant DB as PostgreSQL
    participant Ledger as Double-Entry Ledger

    Merchant->>Settle: POST /api/v1/settlements/batches (period_start, period_end)
    Settle->>DB: Query eligible CAPTURED payments for merchant
    Settle->>DB: Calculate Gross Amount, Platform Fees, and Net Payout
    Settle->>DB: INSERT INTO settlement_batches (status: CREATED)
    
    Merchant->>Settle: POST /api/v1/settlements/batches/:id/process
    Settle->>DB: Lock batch FOR UPDATE
    Settle->>Ledger: Post Balanced Settlement Transaction:
    Note over Ledger: Debit: Merchant Payable (Liability)<br/>Credit: Merchant Bank Clearing (Asset)
    Settle->>DB: UPDATE payments SET status = 'SETTLED'
    Settle->>DB: UPDATE settlement_batches SET status = 'COMPLETED'
    Settle-->>Merchant: HTTP 200 OK (Settlement Processed)
```

---

## 8. Failure Handling & Consistency Guarantees

| Subsystem | Delivery / Execution Semantics | Authoritative Store | Failure Behavior |
| :--- | :--- | :--- | :--- |
| **Payment State Transitions** | Exactly-once via PostgreSQL row locks & unique idempotency keys | PostgreSQL | ACID rollback; zero side effects |
| **Double-Entry Ledger** | Exactly-once; Balanced journal entries | PostgreSQL | Transaction rolls back if debits $\ne$ credits |
| **Outbox Events** | At-least-once to Kafka | PostgreSQL | Polling worker retries until broker ack |
| **Kafka Consumers** | Effectively-once via Idempotent consumer logic | PostgreSQL | Offsets committed only after DB update |
| **Redis Cache / Locks** | Non-authoritative cache & concurrency control | Non-authoritative | Graceful degradation; DB remains ground truth |
| **Reconciliation** | Deterministic batch processing | PostgreSQL | Discrepancies logged; manual resolution workflows |
