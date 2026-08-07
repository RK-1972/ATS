-- OPTALYNX Document Template Management — Sprint 12.3.1
-- Run: psql -U <user> -d <database> -f migrations/034_document_templates_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS cm_document_templates (
  template_id VARCHAR(50) PRIMARY KEY,
  template_code VARCHAR(50) NOT NULL,
  template_name VARCHAR(255) NOT NULL,
  document_category VARCHAR(100) NOT NULL,
  document_path TEXT,
  file_name VARCHAR(255),
  version VARCHAR(20) NOT NULL DEFAULT '1.0',
  effective_from DATE,
  effective_to DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_cm_document_templates_category
  ON cm_document_templates(document_category);

CREATE INDEX IF NOT EXISTS idx_cm_document_templates_code
  ON cm_document_templates(template_code);

CREATE INDEX IF NOT EXISTS idx_cm_document_templates_status
  ON cm_document_templates(status);

-- =====================================================
-- Seed: Permanent Employee Offer Letter
-- =====================================================

INSERT INTO cm_document_templates (
  template_id,
  template_code,
  template_name,
  document_category,
  version,
  effective_from,
  status,
  is_default,
  created_by,
  modified_by
) VALUES (
  'TMPL-PERM-EMP-OFFER-1',
  'PERMANENT_EMPLOYEE_OFFER_LETTER',
  'Permanent Employee Offer Letter',
  'Offer Letter',
  '1.0',
  CURRENT_DATE,
  'Active',
  TRUE,
  'system',
  'system'
)
ON CONFLICT (template_id) DO NOTHING;

COMMIT;
