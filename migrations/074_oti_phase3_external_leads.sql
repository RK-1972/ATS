-- OPTALYNX Talent Intelligence (OTI) — Phase 3 external candidate staging & discovery
-- External leads remain separate from cand_mstr until explicit recruiter import approval.

BEGIN;

ALTER TABLE oti_sourcing_run
  ADD COLUMN IF NOT EXISTS include_external BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE oti_sourcing_run
  ADD COLUMN IF NOT EXISTS external_summary JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS oti_external_lead (
  external_lead_id BIGSERIAL PRIMARY KEY,
  lead_uuid VARCHAR(64) NOT NULL,
  display_name VARCHAR(255),
  headline TEXT,
  "current_role" VARCHAR(255),
  organization VARCHAR(255),
  location VARCHAR(255),
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  experience_indicators JSONB NOT NULL DEFAULT '[]'::jsonb,
  profile_completeness NUMERIC(5, 2) NOT NULL DEFAULT 0,
  import_status VARCHAR(40) NOT NULL DEFAULT 'staged',
  dedup_fingerprint VARCHAR(64) NOT NULL,
  verified_email_hash VARCHAR(64),
  possible_internal_candidate_id INT REFERENCES cand_mstr(candidate_id) ON DELETE SET NULL,
  duplicate_of_lead_id BIGINT REFERENCES oti_external_lead(external_lead_id) ON DELETE SET NULL,
  duplicate_reason VARCHAR(80),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_oti_external_lead_uuid UNIQUE (lead_uuid),
  CONSTRAINT uq_oti_external_lead_fingerprint UNIQUE (dedup_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_oti_external_lead_import_status
  ON oti_external_lead (import_status, updated_on DESC);

CREATE INDEX IF NOT EXISTS idx_oti_external_lead_email_hash
  ON oti_external_lead (verified_email_hash)
  WHERE verified_email_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS oti_external_lead_source (
  source_id BIGSERIAL PRIMARY KEY,
  external_lead_id BIGINT NOT NULL REFERENCES oti_external_lead(external_lead_id) ON DELETE CASCADE,
  provider_key VARCHAR(64) NOT NULL,
  source_record_id VARCHAR(255) NOT NULL,
  profile_url TEXT,
  source_attribution JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_access_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  resume_retrieval_permitted BOOLEAN NOT NULL DEFAULT FALSE,
  licensing_notes TEXT,
  discovered_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retrieved_on TIMESTAMPTZ,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_oti_external_lead_source_provider_record UNIQUE (provider_key, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_oti_external_lead_source_lead
  ON oti_external_lead_source (external_lead_id, discovered_on DESC);

CREATE TABLE IF NOT EXISTS oti_external_lead_snapshot (
  snapshot_id BIGSERIAL PRIMARY KEY,
  external_lead_id BIGINT NOT NULL REFERENCES oti_external_lead(external_lead_id) ON DELETE CASCADE,
  run_id BIGINT REFERENCES oti_sourcing_run(run_id) ON DELETE SET NULL,
  provider_key VARCHAR(64) NOT NULL,
  normalized_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_source_reference JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oti_external_lead_snapshot_lead
  ON oti_external_lead_snapshot (external_lead_id, created_on DESC);

CREATE TABLE IF NOT EXISTS oti_external_run_lead (
  run_lead_id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES oti_sourcing_run(run_id) ON DELETE CASCADE,
  external_lead_id BIGINT NOT NULL REFERENCES oti_external_lead(external_lead_id) ON DELETE CASCADE,
  provider_key VARCHAR(64) NOT NULL,
  rank_order INT NOT NULL DEFAULT 0,
  match_score NUMERIC(8, 4) NOT NULL DEFAULT 0,
  match_explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_oti_external_run_lead UNIQUE (run_id, external_lead_id)
);

CREATE INDEX IF NOT EXISTS idx_oti_external_run_lead_run
  ON oti_external_run_lead (run_id, rank_order ASC);

CREATE TABLE IF NOT EXISTS oti_external_recruiter_action (
  action_id BIGSERIAL PRIMARY KEY,
  external_lead_id BIGINT NOT NULL REFERENCES oti_external_lead(external_lead_id) ON DELETE CASCADE,
  run_id BIGINT REFERENCES oti_sourcing_run(run_id) ON DELETE SET NULL,
  action_type VARCHAR(40) NOT NULL,
  note TEXT,
  actor_employee_code VARCHAR(100) NOT NULL,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oti_external_recruiter_action_lead
  ON oti_external_recruiter_action (external_lead_id, created_on DESC);

COMMIT;
