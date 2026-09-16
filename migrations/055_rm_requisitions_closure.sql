-- Requisition fulfillment closure metadata.
-- Run: psql -U <user> -d <database> -f migrations/055_rm_requisitions_closure.sql

BEGIN;

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS closure_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_rm_requisitions_closed_at
  ON rm_requisitions (closed_at DESC)
  WHERE closed_at IS NOT NULL;

COMMIT;
