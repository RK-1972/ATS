-- OPTALYNX Candidate Employment panel — additive cand_mstr columns only.
-- Adds missing Employment fields used by Candidate Workspace (schema ready only).
-- Does not change APIs, save logic, or existing columns.

BEGIN;

ALTER TABLE cand_mstr
  ADD COLUMN IF NOT EXISTS employment_type VARCHAR(50);

ALTER TABLE cand_mstr
  ADD COLUMN IF NOT EXISTS availability VARCHAR(30);

ALTER TABLE cand_mstr
  ADD COLUMN IF NOT EXISTS ctc_negotiable BOOLEAN;

COMMIT;
