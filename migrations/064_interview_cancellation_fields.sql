-- OPTALYNX Interview cancellation audit fields (additive)
-- Run via migrate:up on isolated environments only.

BEGIN;

ALTER TABLE im_interviews
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

COMMIT;
