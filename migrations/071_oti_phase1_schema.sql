-- OPTALYNX Talent Intelligence (OTI) — Phase 1 internal discovery
-- New tables only.

BEGIN;

CREATE TABLE IF NOT EXISTS oti_sourcing_run (
  run_id BIGSERIAL PRIMARY KEY,
  run_uuid VARCHAR(64) NOT NULL,
  requisition_code VARCHAR(50) NOT NULL REFERENCES rm_requisitions(requisition_code) ON DELETE RESTRICT,
  initiated_by VARCHAR(100) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  query_text TEXT,
  query_structured JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(128),
  error_message TEXT,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_on TIMESTAMPTZ,
  completed_on TIMESTAMPTZ,
  CONSTRAINT uq_oti_sourcing_run_uuid UNIQUE (run_uuid)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oti_sourcing_run_idempotency
  ON oti_sourcing_run (initiated_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND TRIM(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_oti_sourcing_run_requisition
  ON oti_sourcing_run (requisition_code, created_on DESC);

CREATE INDEX IF NOT EXISTS idx_oti_sourcing_run_initiated_by
  ON oti_sourcing_run (initiated_by, created_on DESC);

CREATE TABLE IF NOT EXISTS oti_sourcing_run_step (
  step_id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES oti_sourcing_run(run_id) ON DELETE CASCADE,
  agent_key VARCHAR(64) NOT NULL,
  status VARCHAR(30) NOT NULL,
  input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_ms INT,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oti_sourcing_run_step_run
  ON oti_sourcing_run_step (run_id, step_id);

CREATE TABLE IF NOT EXISTS oti_sourcing_result (
  result_id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES oti_sourcing_run(run_id) ON DELETE CASCADE,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE RESTRICT,
  source_type VARCHAR(30) NOT NULL,
  rank_order INT NOT NULL DEFAULT 0,
  match_pct INT NOT NULL DEFAULT 0,
  rank_score NUMERIC(8, 4) NOT NULL DEFAULT 0,
  matched_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidate_code VARCHAR(50),
  candidate_name VARCHAR(255),
  total_experience NUMERIC(8, 2),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_oti_sourcing_result_run_candidate UNIQUE (run_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_oti_sourcing_result_run
  ON oti_sourcing_result (run_id, rank_order ASC);

CREATE TABLE IF NOT EXISTS oti_recruiter_action (
  action_id BIGSERIAL PRIMARY KEY,
  result_id BIGINT NOT NULL REFERENCES oti_sourcing_result(result_id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES oti_sourcing_run(run_id) ON DELETE CASCADE,
  action_type VARCHAR(40) NOT NULL,
  note TEXT,
  actor_employee_code VARCHAR(100) NOT NULL,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oti_recruiter_action_result
  ON oti_recruiter_action (result_id, created_on DESC);

CREATE INDEX IF NOT EXISTS idx_oti_recruiter_action_run
  ON oti_recruiter_action (run_id, created_on DESC);

COMMIT;
