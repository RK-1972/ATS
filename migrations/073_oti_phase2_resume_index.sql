-- OPTALYNX Talent Intelligence (OTI) — Phase 2 resume indexing & full-text search
-- PostgreSQL tsvector + GIN (no pgvector). External entity_type reserved for future use.

BEGIN;

CREATE TABLE IF NOT EXISTS oti_resume_index (
  index_id BIGSERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  entity_type VARCHAR(30) NOT NULL DEFAULT 'internal',
  resume_path VARCHAR(1024),
  content_hash VARCHAR(64),
  extraction_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  failure_reason TEXT,
  extracted_text TEXT,
  search_text TEXT,
  search_vector tsvector,
  extracted_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  experience_highlights JSONB NOT NULL DEFAULT '[]'::jsonb,
  role_highlights JSONB NOT NULL DEFAULT '[]'::jsonb,
  text_length INT NOT NULL DEFAULT 0,
  byte_length INT NOT NULL DEFAULT 0,
  version_num INT NOT NULL DEFAULT 1,
  indexed_on TIMESTAMPTZ,
  last_attempt_on TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_oti_resume_index_candidate UNIQUE (candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_oti_resume_index_status
  ON oti_resume_index (extraction_status);

CREATE INDEX IF NOT EXISTS idx_oti_resume_index_entity
  ON oti_resume_index (entity_type);

CREATE INDEX IF NOT EXISTS idx_oti_resume_index_search_gin
  ON oti_resume_index USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS oti_resume_index_event (
  event_id BIGSERIAL PRIMARY KEY,
  candidate_id INT NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  status VARCHAR(30),
  message TEXT,
  content_hash VARCHAR(64),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oti_resume_index_event_candidate
  ON oti_resume_index_event (candidate_id, created_on DESC);

CREATE TABLE IF NOT EXISTS oti_index_job (
  job_id BIGSERIAL PRIMARY KEY,
  candidate_id INT NOT NULL,
  job_type VARCHAR(40) NOT NULL DEFAULT 'index_resume',
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oti_index_job_poll
  ON oti_index_job (status, next_run_at)
  WHERE status IN ('queued', 'retry');

CREATE INDEX IF NOT EXISTS idx_oti_index_job_candidate
  ON oti_index_job (candidate_id, created_on DESC);

COMMIT;
