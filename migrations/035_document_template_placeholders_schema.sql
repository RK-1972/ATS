-- OPTALYNX Document Template Placeholders — Sprint 12.3.3
-- Run: psql -U <user> -d <database> -f migrations/035_document_template_placeholders_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS cm_document_template_placeholders (
  template_placeholder_id VARCHAR(50) PRIMARY KEY,
  template_id VARCHAR(50) NOT NULL
    REFERENCES cm_document_templates(template_id) ON DELETE CASCADE,
  placeholder_token VARCHAR(255) NOT NULL,
  namespace VARCHAR(100),
  placeholder_key VARCHAR(100),
  placeholder_type VARCHAR(50) NOT NULL,
  is_valid BOOLEAN NOT NULL DEFAULT FALSE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(template_id, placeholder_token)
);

CREATE INDEX IF NOT EXISTS idx_cm_template_placeholders_template
  ON cm_document_template_placeholders(template_id);

CREATE INDEX IF NOT EXISTS idx_cm_template_placeholders_valid
  ON cm_document_template_placeholders(template_id, is_valid);

COMMIT;
