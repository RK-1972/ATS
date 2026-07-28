-- OPTALYNX — Extend rm_requisitions for Talent Demand editor fields (SoR).
-- Supports Update Existing + Submit Existing without draft dual-path.

BEGIN;

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS job_description TEXT;

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS secondary_skill VARCHAR(255);

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS experience_min NUMERIC(6, 2);

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS experience_max NUMERIC(6, 2);

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS priority_level VARCHAR(50);

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS target_date DATE;

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS client_id BIGINT;

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS project_id BIGINT;

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS hiring_manager_id BIGINT;

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS recruiter_id VARCHAR(50);

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS requestor_submitted_on TIMESTAMPTZ;

COMMIT;
