-- Phase 5G — governed legacy ATS stage alias / translation layer.
-- Run: psql -U <user> -d <database> -f migrations/051_rm_ats_stage_alias.sql

BEGIN;

CREATE TABLE IF NOT EXISTS rm_ats_stage_alias (
  alias_id SERIAL PRIMARY KEY,
  legacy_value VARCHAR(100) NOT NULL,
  stage_id INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_rm_ats_stage_alias_stage
    FOREIGN KEY (stage_id) REFERENCES rm_ats_stage_catalog (stage_id),
  CONSTRAINT uq_rm_ats_stage_alias_legacy_value UNIQUE (legacy_value)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rm_ats_stage_alias_active_legacy
  ON rm_ats_stage_alias (legacy_value)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_rm_ats_stage_alias_stage_id
  ON rm_ats_stage_alias (stage_id)
  WHERE is_active = TRUE;

-- Code-proven funnel bucket equivalences from legacyOperationalAdapter.js switch(row.stage_name).
INSERT INTO rm_ats_stage_alias (legacy_value, stage_id, is_active)
SELECT seed.legacy_value, c.stage_id, TRUE
FROM (
  VALUES
    ('L1 Technical', 'L1_INTERVIEW'),
    ('L1 Non-Technical', 'L1_INTERVIEW'),
    ('L2 Technical', 'L2_INTERVIEW'),
    ('L2 Non-Technical', 'L2_INTERVIEW'),
    ('Client Round', 'CLIENT_INTERVIEW')
) AS seed(legacy_value, stage_code)
INNER JOIN rm_ats_stage_catalog c ON c.stage_code = seed.stage_code
ON CONFLICT (legacy_value) DO UPDATE
SET
  stage_id = EXCLUDED.stage_id,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

COMMIT;
