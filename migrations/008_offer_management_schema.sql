-- OPTALYNX Enterprise Offer Management — Schema Sprint 8
-- Run: psql -U <user> -d <database> -f migrations/008_offer_management_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS om_offers (
  offer_id VARCHAR(50) PRIMARY KEY,
  approved_position_id VARCHAR(50),
  requisition_code VARCHAR(50),
  candidate_id INT,
  mapping_id INT,
  interview_id VARCHAR(50),
  recruiter_id VARCHAR(100),
  hiring_manager VARCHAR(255),
  candidate_name VARCHAR(255),
  position_title VARCHAR(255),
  grade VARCHAR(50),
  department VARCHAR(255),
  location VARCHAR(255),
  business_unit VARCHAR(255),
  employment_type VARCHAR(50) DEFAULT 'Full-time',
  approved_budget NUMERIC(14, 2) NOT NULL DEFAULT 0,
  offered_ctc NUMERIC(14, 2) NOT NULL DEFAULT 0,
  variance_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  variance_pct NUMERIC(6, 2) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  offer_status VARCHAR(50) NOT NULL DEFAULT 'Draft',
  workflow_instance_id VARCHAR(100),
  validity_days INT NOT NULL DEFAULT 7,
  valid_until DATE,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  modified_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_om_offers_status ON om_offers(offer_status);
CREATE INDEX IF NOT EXISTS idx_om_offers_requisition ON om_offers(requisition_code);
CREATE INDEX IF NOT EXISTS idx_om_offers_candidate ON om_offers(candidate_id);
CREATE INDEX IF NOT EXISTS idx_om_offers_workflow ON om_offers(workflow_instance_id);

CREATE TABLE IF NOT EXISTS om_offer_compensation (
  compensation_id SERIAL PRIMARY KEY,
  offer_id VARCHAR(50) NOT NULL REFERENCES om_offers(offer_id) ON DELETE CASCADE,
  base_salary NUMERIC(14, 2) NOT NULL DEFAULT 0,
  variable_pay NUMERIC(14, 2) NOT NULL DEFAULT 0,
  bonus NUMERIC(14, 2) NOT NULL DEFAULT 0,
  benefits NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_ctc NUMERIC(14, 2) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  salary_band_code VARCHAR(50),
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS om_offer_approvals (
  approval_id SERIAL PRIMARY KEY,
  offer_id VARCHAR(50) NOT NULL REFERENCES om_offers(offer_id) ON DELETE CASCADE,
  approval_step VARCHAR(100) NOT NULL,
  approver_role VARCHAR(100) NOT NULL,
  approver_name VARCHAR(255),
  approval_status VARCHAR(50) NOT NULL DEFAULT 'Pending',
  sequence_order INT NOT NULL DEFAULT 1,
  comments TEXT,
  approved_on TIMESTAMPTZ,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_om_offer_approvals_offer ON om_offer_approvals(offer_id);

CREATE TABLE IF NOT EXISTS om_offer_negotiations (
  negotiation_id SERIAL PRIMARY KEY,
  offer_id VARCHAR(50) NOT NULL REFERENCES om_offers(offer_id) ON DELETE CASCADE,
  round_no INT NOT NULL DEFAULT 1,
  proposed_ctc NUMERIC(14, 2) NOT NULL DEFAULT 0,
  counter_ctc NUMERIC(14, 2),
  negotiation_status VARCHAR(50) NOT NULL DEFAULT 'Open',
  initiated_by VARCHAR(255),
  notes TEXT,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS om_offer_revisions (
  revision_id SERIAL PRIMARY KEY,
  offer_id VARCHAR(50) NOT NULL,
  version NUMERIC(5, 1) NOT NULL,
  revision_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  payload JSONB NOT NULL,
  reason TEXT,
  revised_by VARCHAR(255),
  revised_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS om_offer_documents (
  document_id SERIAL PRIMARY KEY,
  offer_id VARCHAR(50) NOT NULL REFERENCES om_offers(offer_id) ON DELETE CASCADE,
  template_code VARCHAR(100),
  document_type VARCHAR(100) NOT NULL DEFAULT 'Offer Letter',
  document_status VARCHAR(50) NOT NULL DEFAULT 'Draft',
  content_ref TEXT,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  generated_by VARCHAR(255),
  generated_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS om_offer_acceptance (
  acceptance_id SERIAL PRIMARY KEY,
  offer_id VARCHAR(50) NOT NULL REFERENCES om_offers(offer_id) ON DELETE CASCADE,
  response_status VARCHAR(50) NOT NULL DEFAULT 'Pending',
  accepted_on TIMESTAMPTZ,
  declined_on TIMESTAMPTZ,
  decline_reason TEXT,
  pre_onboarding_status VARCHAR(50) DEFAULT 'Not Started',
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  responded_by VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS om_offer_history (
  history_id SERIAL PRIMARY KEY,
  offer_id VARCHAR(50) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  from_status VARCHAR(50),
  to_status VARCHAR(50),
  actor VARCHAR(255),
  actor_role VARCHAR(100),
  comments TEXT,
  metadata JSONB,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_om_offer_history_offer ON om_offer_history(offer_id);

COMMIT;
