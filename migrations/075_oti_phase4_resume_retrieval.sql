-- OPTALYNX Talent Intelligence (OTI) — Phase 4 licensed resume retrieval & secure documents

BEGIN;

ALTER TABLE oti_external_lead
  ADD COLUMN IF NOT EXISTS resume_retrieval_status VARCHAR(40) NOT NULL DEFAULT 'not_requested';

ALTER TABLE oti_external_lead
  ADD COLUMN IF NOT EXISTS resume_index_status VARCHAR(40);

ALTER TABLE oti_external_lead
  ADD COLUMN IF NOT EXISTS latest_document_id BIGINT;

CREATE TABLE IF NOT EXISTS oti_resume_retrieval_grant (
  grant_id BIGSERIAL PRIMARY KEY,
  grant_uuid VARCHAR(64) NOT NULL,
  external_lead_id BIGINT NOT NULL REFERENCES oti_external_lead(external_lead_id) ON DELETE CASCADE,
  provider_key VARCHAR(64) NOT NULL,
  requested_by VARCHAR(100) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  expires_on TIMESTAMPTZ NOT NULL,
  consumed_on TIMESTAMPTZ,
  revoked_on TIMESTAMPTZ,
  replay_nonce VARCHAR(64) NOT NULL,
  permission_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  document_id BIGINT,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 1,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_oti_resume_retrieval_grant_uuid UNIQUE (grant_uuid)
);

CREATE INDEX IF NOT EXISTS idx_oti_resume_retrieval_grant_lead
  ON oti_resume_retrieval_grant (external_lead_id, created_on DESC);

CREATE INDEX IF NOT EXISTS idx_oti_resume_retrieval_grant_status
  ON oti_resume_retrieval_grant (status, expires_on);

CREATE TABLE IF NOT EXISTS oti_external_resume_document (
  document_id BIGSERIAL PRIMARY KEY,
  external_lead_id BIGINT NOT NULL REFERENCES oti_external_lead(external_lead_id) ON DELETE CASCADE,
  grant_id BIGINT REFERENCES oti_resume_retrieval_grant(grant_id) ON DELETE SET NULL,
  provider_key VARCHAR(64) NOT NULL,
  storage_key VARCHAR(1024) NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  mime_type VARCHAR(120),
  detected_format VARCHAR(20),
  byte_length INT NOT NULL DEFAULT 0,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_oti_external_resume_document_hash UNIQUE (external_lead_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_oti_external_resume_document_lead
  ON oti_external_resume_document (external_lead_id, created_on DESC);

ALTER TABLE oti_external_lead
  ADD CONSTRAINT fk_oti_external_lead_latest_document
  FOREIGN KEY (latest_document_id) REFERENCES oti_external_resume_document(document_id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS oti_external_resume_index (
  index_id BIGSERIAL PRIMARY KEY,
  external_lead_id BIGINT NOT NULL REFERENCES oti_external_lead(external_lead_id) ON DELETE CASCADE,
  document_id BIGINT REFERENCES oti_external_resume_document(document_id) ON DELETE SET NULL,
  storage_key VARCHAR(1024),
  content_hash VARCHAR(64),
  extraction_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  failure_reason TEXT,
  extracted_text TEXT,
  search_text TEXT,
  search_vector tsvector,
  extracted_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  text_length INT NOT NULL DEFAULT 0,
  byte_length INT NOT NULL DEFAULT 0,
  indexed_on TIMESTAMPTZ,
  last_attempt_on TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_oti_external_resume_index_lead UNIQUE (external_lead_id)
);

CREATE INDEX IF NOT EXISTS idx_oti_external_resume_index_gin
  ON oti_external_resume_index USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS oti_resume_retrieval_event (
  event_id BIGSERIAL PRIMARY KEY,
  grant_id BIGINT,
  external_lead_id BIGINT NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  status VARCHAR(30),
  message TEXT,
  actor_employee_code VARCHAR(100),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oti_resume_retrieval_event_lead
  ON oti_resume_retrieval_event (external_lead_id, created_on DESC);

COMMIT;
