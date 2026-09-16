-- Phase 5B — governed Enterprise ATS pipeline stage catalog.
-- Run: psql -U <user> -d <database> -f migrations/050_rm_ats_stage_catalog.sql

BEGIN;

CREATE TABLE IF NOT EXISTS rm_ats_stage_catalog (
  stage_id SERIAL PRIMARY KEY,
  stage_code VARCHAR(50) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  sort_order INT NOT NULL,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rm_ats_stage_catalog_code UNIQUE (stage_code),
  CONSTRAINT uq_rm_ats_stage_catalog_display_name UNIQUE (display_name),
  CONSTRAINT uq_rm_ats_stage_catalog_sort_order UNIQUE (sort_order)
);

CREATE INDEX IF NOT EXISTS idx_rm_ats_stage_catalog_active_sort
  ON rm_ats_stage_catalog (sort_order)
  WHERE is_active = TRUE;

-- Canonical Enterprise vocabulary from recruiterSelectors.PIPELINE_STAGES.
INSERT INTO rm_ats_stage_catalog (
  stage_code,
  display_name,
  sort_order,
  is_terminal,
  is_active
)
VALUES
  ('APPLIED', 'Applied', 10, FALSE, TRUE),
  ('SCREENING', 'Screening', 20, FALSE, TRUE),
  ('L1_INTERVIEW', 'L1 Interview', 30, FALSE, TRUE),
  ('L2_INTERVIEW', 'L2 Interview', 40, FALSE, TRUE),
  ('CLIENT_INTERVIEW', 'Client Interview', 50, FALSE, TRUE),
  ('OFFER', 'Offer', 60, FALSE, TRUE),
  ('JOINED', 'Joined', 70, TRUE, TRUE)
ON CONFLICT (stage_code) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  is_terminal = EXCLUDED.is_terminal,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

COMMIT;
