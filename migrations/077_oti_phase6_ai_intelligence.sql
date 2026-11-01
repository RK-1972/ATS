-- OPTALYNX Talent Intelligence (OTI) — Phase 6 AI-assisted JD intelligence (not executed in CI by agent policy)

BEGIN;

ALTER TABLE oti_sourcing_run
  ADD COLUMN IF NOT EXISTS include_ai_assist BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE oti_sourcing_run
  ADD COLUMN IF NOT EXISTS jd_intelligence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE oti_sourcing_run
  ADD COLUMN IF NOT EXISTS search_strategy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE oti_sourcing_run
  ADD COLUMN IF NOT EXISTS provider_selection_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE oti_sourcing_run
  ADD COLUMN IF NOT EXISTS ai_usage_summary JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS oti_ai_usage_log (
  usage_id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES oti_sourcing_run(run_id) ON DELETE SET NULL,
  model_provider VARCHAR(40) NOT NULL,
  model_id VARCHAR(80) NOT NULL,
  request_type VARCHAR(64) NOT NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  total_tokens INT NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  success BOOLEAN NOT NULL DEFAULT TRUE,
  error_message TEXT,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oti_ai_usage_log_run
  ON oti_ai_usage_log (run_id, created_on DESC);

COMMIT;
