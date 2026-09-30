# LedgerX Backup, Recovery & Disaster Management Strategy

This document defines the production backup, point-in-time recovery (PITR), and disaster recovery procedures for the **LedgerX Financial Infrastructure Platform**.

---

## 1. Architectural Authority of Record

| Component | Role | Disaster Recovery Classification | Authoritative? |
| :--- | :--- | :--- | :--- |
| **PostgreSQL** | Primary Financial Core | **Tier 1 (Critical)**: RPO = 0, RTO < 15 min | **YES (Absolute Authority)** |
| **Kafka Cluster** | Event Streaming Log | **Tier 2 (High)**: RPO < 5 min, RTO < 30 min | Reconstructible from Outbox |
| **Redis** | Locks, Cache, Rate Limits | **Tier 3 (Ephemeral)**: RPO = N/A, RTO < 2 min | **NO** (Auto-repopulated) |

> [!IMPORTANT]
> **Financial Source of Truth**: PostgreSQL is the single source of truth for all balances, payments, refunds, and ledger transactions. If Redis or Kafka are completely wiped, the full financial state remains intact and recoverable.

---

## 2. PostgreSQL Backup Strategy

### A. Continuous Write-Ahead Log (WAL) Archiving (Point-in-Time Recovery)
- **Archive Command**: Ships closed 16MB WAL segments to encrypted cloud object storage (e.g. AWS S3, GCP Cloud Storage) immediately upon rotation:
  ```ini
  # postgresql.conf
  wal_level = replica
  archive_mode = on
  archive_command = 'test ! -f /mnt/wal_archive/%f && cp %p /mnt/wal_archive/%f'
  archive_timeout = 300 # Forces rotation at least every 5 minutes
  ```

### B. Daily Automated Base Backups (`pg_basebackup`)
Executed daily during low-traffic windows (02:00 UTC) with tar-gz compression and MD5 checksums:
```bash
pg_basebackup \
  -h localhost \
  -p 5432 \
  -U ledgerx_backup_user \
  -D /backups/postgres/base_$(date +%Y%m%d_%H%M%S) \
  -F tar -z -P -v
```

### C. Logical Snapshots (`pg_dump`)
Nightly schema and relational data dumps for disaster isolation and audit forensics:
```bash
pg_dump \
  --host=localhost \
  --port=5432 \
  --username=ledgerx_user \
  --format=custom \
  --blobs \
  --file=/backups/logical/ledgerx_logical_$(date +%Y%m%d).dump \
  ledgerx_db
```

---

## 3. Disaster Recovery & Restoration Runbook

### Step 1: Stop Application Traffic
Immediately switch API Gateway to maintenance mode or scale application pods down to avoid partial state writes:
```bash
docker compose -f docker-compose.prod.yml stop ledgerx-app
```

### Step 2: Restore Base Backup
Extract base backup into a clean PostgreSQL data directory:
```bash
rm -rf /var/lib/postgresql/data/*
tar -xzf /backups/postgres/base_YYYYMMDD_HHMMSS/base.tar.gz -C /var/lib/postgresql/data/
```

### Step 3: Configure Recovery Signal & Target Time
Create `recovery.signal` and define point-in-time recovery parameters in `postgresql.auto.conf`:
```ini
restore_command = 'cp /mnt/wal_archive/%f %p'
recovery_target_time = '2026-09-30 00:00:00 UTC'
recovery_target_action = 'promote'
```

### Step 4: Start Database & Verify Replay
Start PostgreSQL and monitor recovery logs until target promote:
```bash
tail -f /var/log/postgresql/postgresql.log | grep -E "restored log file|redo starts at|recovery complete"
```

### Step 5: Financial Invariant Verification Query
**MANDATORY**: Run the balance verification script to assert double-entry equality before opening traffic:
```sql
-- Assert that Total Debits strictly equals Total Credits across the entire ledger
SELECT 
    SUM(CASE WHEN entry_type = 'DEBIT' THEN amount_minor ELSE 0 END) AS total_debits,
    SUM(CASE WHEN entry_type = 'CREDIT' THEN amount_minor ELSE 0 END) AS total_credits,
    (SUM(CASE WHEN entry_type = 'DEBIT' THEN amount_minor ELSE 0 END) -
     SUM(CASE WHEN entry_type = 'CREDIT' THEN amount_minor ELSE 0 END)) AS variance_minor
FROM ledger_entries;
-- EXPECTED: variance_minor MUST BE 0
```

---

## 4. Redis Catastrophic Failure Recovery

1. **Failure Impact**: Redis stores distributed lock keys, token bucket rate limits, and short-lived payment caches.
2. **Recovery Procedure**:
   - Start a fresh Redis container (`docker compose -f docker-compose.prod.yml up -d redis`).
   - If real Redis is unavailable, LedgerX automatically operates in **In-Memory Resilient Mode**.
   - No data restoration is needed because cache keys populate on-demand from PostgreSQL.

---

## 5. Kafka Cluster Recovery & Event Replay

1. **Failure Impact**: Event streaming pause or consumer partition lag.
2. **Re-synchronization via Transactional Outbox**:
   - All events emitted by LedgerX are transactionally committed to `outbox_events` table in PostgreSQL before reaching Kafka.
   - Run the standalone outbox replay command to stream all unpublished or uncommitted events:
     ```bash
     npm run outbox:worker
     ```

---

## 6. Zero-Downtime Migration Policy (Expand-Contract)

To avoid locks and downtime during Prisma schema upgrades:
1. **Expand**: Add new columns or nullable fields without modifying existing readers.
2. **Deploy Application**: Roll out new application version reading and writing both old and new columns.
3. **Contract**: Migrate old data in batches and drop deprecated columns in a follow-up migration.
4. **Foreign Key Safety**: Always specify index on foreign key columns and avoid full table locks (`CONCURRENTLY` in Postgres indexes).
