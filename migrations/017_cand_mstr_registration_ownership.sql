-- OPTALYNX Candidate Registration ownership — additive cand_mstr columns only.
-- Supports Register Candidate: candidate_container, owner, registered_by/on.
-- Does not modify existing columns, indexes, or other tables.

BEGIN;

ALTER TABLE cand_mstr
  ADD COLUMN IF NOT EXISTS candidate_container VARCHAR(30) NOT NULL DEFAULT 'PIPELINE';

ALTER TABLE cand_mstr
  ADD COLUMN IF NOT EXISTS owner_employee_code VARCHAR(100);

ALTER TABLE cand_mstr
  ADD COLUMN IF NOT EXISTS registered_by VARCHAR(100);

ALTER TABLE cand_mstr
  ADD COLUMN IF NOT EXISTS registered_on TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cand_mstr_candidate_container_check'
  ) THEN
    ALTER TABLE cand_mstr
      ADD CONSTRAINT cand_mstr_candidate_container_check
      CHECK (candidate_container IN ('PIPELINE', 'TALENT_POOL'));
  END IF;
END $$;

COMMIT;
