-- OPTALYNX schema migration ledger (Migration Manager Phase 1).
-- Run via: npm run migrate:up (after OPTALYNX_DB_TARGET is set), not via legacy runMigrations.js.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename VARCHAR(255) PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by VARCHAR(255),
  duration_ms INT
);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON schema_migrations (applied_at DESC);

CREATE TABLE IF NOT EXISTS schema_migration_orphans (
  filename VARCHAR(255) PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detected_by VARCHAR(255),
  cause_code VARCHAR(64) NOT NULL DEFAULT 'MIGRATION_LEDGER_ORPHAN',
  cause_detail TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_schema_migration_orphans_unresolved
  ON schema_migration_orphans (detected_at DESC)
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS schema_migration_recovery_blocks (
  filename VARCHAR(255) PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  reason_code VARCHAR(64) NOT NULL,
  detail TEXT,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_by VARCHAR(255)
);

COMMIT;
