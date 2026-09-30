-- LedgerX Core Schema Initialization Script
-- Designed for High-Integrity Financial Processing & Reconciliation

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==========================================
-- 1. ENUMS
-- ==========================================
CREATE TYPE user_role AS ENUM ('ADMIN', 'MERCHANT', 'USER', 'AUDITOR');
CREATE TYPE account_type AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE', 'CLEARING');
CREATE TYPE payment_status AS ENUM (
    'CREATED',
    'PENDING',
    'AUTHORIZED',
    'CAPTURED',
    'PARTIALLY_REFUNDED',
    'REFUND_PENDING',
    'REFUNDED',
    'CANCELLED',
    'FAILED',
    'SETTLED'
);
CREATE TYPE payment_attempt_status AS ENUM ('INITIATED', 'SUCCESSFUL', 'FAILED');
CREATE TYPE refund_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE entry_type AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE risk_level AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE risk_decision AS ENUM ('ALLOW', 'REVIEW', 'BLOCK', 'APPROVE', 'DECLINE');
CREATE TYPE reconciliation_status AS ENUM ('UNMATCHED', 'MATCHED', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'DUPLICATE', 'RESOLVED');
CREATE TYPE reconciliation_run_status AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL');
CREATE TYPE reconciliation_result AS ENUM ('MATCHED', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'MISSING_INTERNAL', 'MISSING_EXTERNAL', 'DUPLICATE_EXTERNAL', 'DUPLICATE_INTERNAL', 'CURRENCY_MISMATCH');
CREATE TYPE discrepancy_status AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'WAIVED');
CREATE TYPE settlement_batch_status AS ENUM (
    'PENDING',
    'PROCESSING',
    'RECONCILED',
    'READY',
    'PROCESSING_SETTLEMENT',
    'SETTLED',
    'FAILED',
    'CANCELLED'
);
CREATE TYPE settlement_record_status AS ENUM (
    'PENDING',
    'INCLUDED',
    'SETTLED',
    'EXCLUDED',
    'FAILED'
);
CREATE TYPE webhook_event_status AS ENUM ('RECEIVED', 'VALIDATED', 'PROCESSING', 'PROCESSED', 'RETRY_PENDING', 'FAILED', 'DEAD_LETTERED');
CREATE TYPE dead_letter_status AS ENUM ('PENDING', 'REPLAYED', 'RESOLVED', 'IGNORED');

-- ==========================================
-- 2. CORE DOMAIN: USERS & MERCHANTS
-- ==========================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'MERCHANT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    business_name VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    api_key_hash VARCHAR(255),
    webhook_url VARCHAR(1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- 3. FINANCIAL ENGINE: DOUBLE-ENTRY LEDGER
-- ==========================================
CREATE TABLE IF NOT EXISTS ledger_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE, -- NULL indicates platform internal account
    code VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    type account_type NOT NULL,
    currency VARCHAR(3) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_merchant_account_code_currency UNIQUE (merchant_id, code, currency)
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_id UUID,
    reference_type VARCHAR(64) NOT NULL, -- e.g. PAYMENT, REFUND, SETTLEMENT, FEE
    transaction_type VARCHAR(64) NOT NULL DEFAULT 'PAYMENT', -- PAYMENT, CAPTURE, REFUND, SETTLEMENT, ADJUSTMENT
    currency VARCHAR(3) NOT NULL,
    description TEXT,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ledger_transactions_reference UNIQUE (reference_type, reference_id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
    entry_type entry_type NOT NULL,
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    currency VARCHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_reference ON ledger_transactions(reference_id, reference_type);

-- ==========================================
-- 4. PAYMENTS & REFUNDS
-- ==========================================
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    currency VARCHAR(3) NOT NULL,
    status payment_status NOT NULL DEFAULT 'CREATED',
    idempotency_key VARCHAR(255),
    captured_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (captured_amount_minor >= 0),
    refunded_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount_minor >= 0),
    description TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_refund_not_exceed_captured CHECK (refunded_amount_minor <= captured_amount_minor),
    CONSTRAINT chk_captured_not_exceed_amount CHECK (captured_amount_minor <= amount_minor)
);

CREATE INDEX IF NOT EXISTS idx_payments_merchant_status ON payments(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);

CREATE TABLE IF NOT EXISTS payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    attempt_number INT NOT NULL,
    gateway_reference VARCHAR(255),
    status payment_attempt_status NOT NULL,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_payment_attempt_number UNIQUE (payment_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    currency VARCHAR(3) NOT NULL,
    status refund_status NOT NULL DEFAULT 'PENDING',
    idempotency_key VARCHAR(255),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);

-- ==========================================
-- 5. IDEMPOTENCY SYSTEM
-- ==========================================
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(255) UNIQUE NOT NULL,
    merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
    request_method VARCHAR(16) NOT NULL,
    request_path VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'IN_PROGRESS', -- IN_PROGRESS, COMPLETED, FAILED
    response_status INT,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_key ON idempotency_keys(key);
CREATE INDEX IF NOT EXISTS idx_idempotency_merchant_key ON idempotency_keys(merchant_id, key);

-- ==========================================
-- ==========================================
-- 6. RISK ENGINE (Milestone 8)
-- ==========================================
CREATE TABLE IF NOT EXISTS risk_assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    risk_score INT NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
    risk_level risk_level NOT NULL,
    decision risk_decision NOT NULL,
    triggered_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_version VARCHAR(32) NOT NULL DEFAULT 'rules-v1',
    evaluation_duration_ms INT,
    correlation_id VARCHAR(64),
    evaluation_status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_assessments_payment ON risk_assessments(payment_id);
CREATE INDEX IF NOT EXISTS idx_risk_assessments_decision ON risk_assessments(decision, created_at);
CREATE INDEX IF NOT EXISTS idx_risk_assessments_level ON risk_assessments(risk_level, created_at);

CREATE TABLE IF NOT EXISTS risk_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- 7. SETTLEMENT & RECONCILIATION
-- ==========================================
CREATE TABLE IF NOT EXISTS settlement_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_reference VARCHAR(128) UNIQUE NOT NULL,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    currency VARCHAR(3) NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    gross_amount_minor BIGINT NOT NULL DEFAULT 0,
    refund_amount_minor BIGINT NOT NULL DEFAULT 0,
    adjustment_amount_minor BIGINT NOT NULL DEFAULT 0,
    fee_amount_minor BIGINT NOT NULL DEFAULT 0,
    net_amount_minor BIGINT NOT NULL DEFAULT 0,
    status settlement_batch_status NOT NULL DEFAULT 'PENDING',
    record_count INT NOT NULL DEFAULT 0,
    ledger_transaction_id UUID,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_settlement_merchant_period UNIQUE (merchant_id, currency, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_settlement_batches_merchant_status ON settlement_batches(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_settlement_batches_status ON settlement_batches(status, created_at);

CREATE TABLE IF NOT EXISTS settlement_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES settlement_batches(id) ON DELETE CASCADE,
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    ledger_transaction_id UUID,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    gross_amount_minor BIGINT NOT NULL,
    refund_amount_minor BIGINT NOT NULL DEFAULT 0,
    fee_amount_minor BIGINT NOT NULL DEFAULT 0,
    net_amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL,
    status settlement_record_status NOT NULL DEFAULT 'PENDING',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_records_batch_status ON settlement_records(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_settlement_records_payment ON settlement_records(payment_id);
CREATE INDEX IF NOT EXISTS idx_settlement_records_merchant ON settlement_records(merchant_id);

CREATE TABLE IF NOT EXISTS external_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(64) NOT NULL,
    external_transaction_id VARCHAR(128) NOT NULL,
    external_reference VARCHAR(255) NOT NULL,
    payment_reference VARCHAR(255),
    transaction_type VARCHAR(64) NOT NULL DEFAULT 'PAYMENT',
    amount_minor BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(64) NOT NULL,
    transaction_timestamp TIMESTAMPTZ NOT NULL,
    settlement_date TIMESTAMPTZ,
    raw_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_external_transactions_provider_id UNIQUE (provider, external_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_external_tx_provider_time ON external_transactions(provider, transaction_timestamp);
CREATE INDEX IF NOT EXISTS idx_external_tx_ext_ref ON external_transactions(external_reference);
CREATE INDEX IF NOT EXISTS idx_external_tx_pay_ref ON external_transactions(payment_reference);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_reference VARCHAR(128) UNIQUE NOT NULL,
    provider VARCHAR(64) NOT NULL DEFAULT 'mockpay',
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    status reconciliation_run_status NOT NULL DEFAULT 'PENDING',
    total_internal_records INT NOT NULL DEFAULT 0,
    total_external_records INT NOT NULL DEFAULT 0,
    matched_count INT NOT NULL DEFAULT 0,
    mismatch_count INT NOT NULL DEFAULT 0,
    missing_internal_count INT NOT NULL DEFAULT 0,
    missing_external_count INT NOT NULL DEFAULT 0,
    duplicate_count INT NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_provider ON reconciliation_runs(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_status ON reconciliation_runs(status, created_at);

CREATE TABLE IF NOT EXISTS reconciliation_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
    internal_reference VARCHAR(255),
    external_reference VARCHAR(255),
    internal_transaction_id UUID REFERENCES payments(id) ON DELETE SET NULL,
    external_transaction_id VARCHAR(128),
    external_db_record_id UUID REFERENCES external_transactions(id) ON DELETE SET NULL,
    result reconciliation_result NOT NULL,
    difference_minor BIGINT NOT NULL DEFAULT 0,
    reason TEXT,
    status discrepancy_status NOT NULL DEFAULT 'OPEN',
    resolved_by VARCHAR(128),
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT,
    internal_amount_minor BIGINT,
    external_amount_minor BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recon_records_run_result ON reconciliation_records(run_id, result);
CREATE INDEX IF NOT EXISTS idx_recon_records_status ON reconciliation_records(status);
CREATE INDEX IF NOT EXISTS idx_recon_records_internal_ref ON reconciliation_records(internal_reference);
CREATE INDEX IF NOT EXISTS idx_recon_records_external_ref ON reconciliation_records(external_reference);

-- ==========================================
-- 8. WEBHOOK PROCESSOR & ASYNCHRONOUS EVENTS (Milestone 7)
-- ==========================================
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(128) NOT NULL,
    provider VARCHAR(64) NOT NULL DEFAULT 'mockpay',
    event_type VARCHAR(64) NOT NULL,
    external_reference VARCHAR(255),
    merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
    signature VARCHAR(512),
    payload JSONB NOT NULL,
    status webhook_event_status NOT NULL DEFAULT 'RECEIVED',
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    last_error TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_webhook_events_provider_event UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_queue ON webhook_events(status, next_retry_at);

CREATE TABLE IF NOT EXISTS dead_letter_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(128) NOT NULL,
    source VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    reason TEXT NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    status dead_letter_status NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by VARCHAR(128),
    resolution_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_events_status ON dead_letter_events(status, created_at);
CREATE INDEX IF NOT EXISTS idx_dead_letter_events_event_id ON dead_letter_events(event_id);

-- ==========================================
-- 9. AUDIT LOGGING
-- ==========================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(64) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    actor_id VARCHAR(64),
    actor_type VARCHAR(32) NOT NULL DEFAULT 'USER',
    changes JSONB,
    ip_address VARCHAR(45),
    correlation_id VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation ON audit_logs(correlation_id);

-- ==========================================
-- 10. TRANSACTIONAL OUTBOX & EVENT STREAMING (Milestone 6)
-- ==========================================
CREATE TYPE outbox_status AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(64) UNIQUE NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    topic VARCHAR(128) NOT NULL,
    partition_key VARCHAR(128) NOT NULL,
    correlation_id VARCHAR(64),
    status outbox_status NOT NULL DEFAULT 'PENDING',
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_queue ON outbox_events(status, created_at) WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate ON outbox_events(aggregate_type, aggregate_id);

CREATE TABLE IF NOT EXISTS processed_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(64) NOT NULL,
    consumer_group VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_processed_events_event_group UNIQUE (event_id, consumer_group)
);

CREATE INDEX IF NOT EXISTS idx_processed_events_group ON processed_events(consumer_group, processed_at);

