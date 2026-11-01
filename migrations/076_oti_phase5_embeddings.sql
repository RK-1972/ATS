-- OPTALYNX Talent Intelligence (OTI) — Phase 5 embeddings & semantic retrieval
-- JSONB embeddings work without pgvector. Vector column is optional (see docs/OTI_PHASE5_DATABASE_CAPABILITY.md).
-- DO NOT run CREATE EXTENSION in production without DBA approval.

BEGIN;

CREATE TABLE IF NOT EXISTS oti_embedding_record (
  embedding_id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(40) NOT NULL,
  entity_id INT NOT NULL,
  source_kind VARCHAR(40) NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  model_provider VARCHAR(40) NOT NULL,
  model_id VARCHAR(80) NOT NULL,
  model_version VARCHAR(40) NOT NULL DEFAULT 'v1',
  dimensions INT NOT NULL DEFAULT 0,
  token_count INT NOT NULL DEFAULT 0,
  embedding_json JSONB NOT NULL,
  storage_backend VARCHAR(20) NOT NULL DEFAULT 'jsonb',
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_oti_embedding_record_identity UNIQUE (
    entity_type, entity_id, source_kind, content_hash, model_id
  )
);

CREATE INDEX IF NOT EXISTS idx_oti_embedding_record_entity
  ON oti_embedding_record (entity_type, entity_id, source_kind);

CREATE INDEX IF NOT EXISTS idx_oti_embedding_record_model
  ON oti_embedding_record (model_provider, model_id, model_version);

CREATE TABLE IF NOT EXISTS oti_embedding_usage_log (
  usage_id BIGSERIAL PRIMARY KEY,
  model_provider VARCHAR(40) NOT NULL,
  model_id VARCHAR(80) NOT NULL,
  request_type VARCHAR(40) NOT NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  total_tokens INT NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  entity_type VARCHAR(40),
  entity_id INT,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oti_embedding_usage_log_created
  ON oti_embedding_usage_log (created_on DESC);

CREATE TABLE IF NOT EXISTS oti_embedding_job (
  job_id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(40) NOT NULL,
  entity_id INT NOT NULL,
  source_kind VARCHAR(40) NOT NULL DEFAULT 'resume',
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oti_embedding_job_poll
  ON oti_embedding_job (status, next_run_at)
  WHERE status IN ('queued', 'retry');

ALTER TABLE oti_sourcing_run
  ADD COLUMN IF NOT EXISTS include_semantic BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE oti_sourcing_run
  ADD COLUMN IF NOT EXISTS semantic_summary JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Optional pgvector upgrade (execute only when extension is approved and installed):
-- CREATE EXTENSION IF NOT EXISTS vector;
-- ALTER TABLE oti_embedding_record ADD COLUMN IF NOT EXISTS embedding_vector vector(1536);
-- CREATE INDEX IF NOT EXISTS idx_oti_embedding_record_vector
--   ON oti_embedding_record USING ivfflat (embedding_vector vector_cosine_ops) WITH (lists = 100);

COMMIT;
