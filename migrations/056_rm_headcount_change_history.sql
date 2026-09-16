-- Governed requisition headcount change history (immutable audit trail).
-- Run: psql -U <user> -d <database> -f migrations/056_rm_headcount_change_history.sql

BEGIN;

CREATE TABLE IF NOT EXISTS rm_headcount_change_history (
  change_id VARCHAR(64) PRIMARY KEY,
  requisition_code VARCHAR(64) NOT NULL,
  old_headcount INT NOT NULL,
  requested_headcount INT NOT NULL,
  change_type VARCHAR(20) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'Pending Approval',
  requested_by VARCHAR(255) NOT NULL,
  requested_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by VARCHAR(255),
  approved_on TIMESTAMPTZ,
  rejected_by VARCHAR(255),
  rejected_on TIMESTAMPTZ,
  approval_outcome VARCHAR(40),
  workflow_instance_id VARCHAR(128),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rm_headcount_change_history_requisition_fkey
    FOREIGN KEY (requisition_code)
    REFERENCES rm_requisitions (requisition_code)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rm_headcount_change_requisition
  ON rm_headcount_change_history (requisition_code, requested_on DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_headcount_change_pending_unique
  ON rm_headcount_change_history (requisition_code)
  WHERE status = 'Pending Approval';

COMMIT;
