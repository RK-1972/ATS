-- OPTALYNX Generated Documents — Sprint 12.3.4
-- Run: psql -U <user> -d <database> -f migrations/036_generated_documents_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS om_generated_documents (
  document_id VARCHAR(50) PRIMARY KEY,
  document_type VARCHAR(100) NOT NULL,
  business_object_type VARCHAR(50) NOT NULL,
  business_object_id VARCHAR(50) NOT NULL,
  template_id VARCHAR(50)
    REFERENCES cm_document_templates(template_id) ON DELETE SET NULL,
  document_path TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Generated',
  generated_by VARCHAR(255),
  generated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_om_generated_documents_business
  ON om_generated_documents(business_object_type, business_object_id);

CREATE INDEX IF NOT EXISTS idx_om_generated_documents_template
  ON om_generated_documents(template_id);

COMMIT;
