-- OPTALYNX Enterprise Master Data — Schema Sprint 1
-- Run: psql -U <user> -d <database> -f migrations/001_master_data_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS md_entity_types (
  entity_type VARCHAR(50) PRIMARY KEY,
  domain_key VARCHAR(50) NOT NULL,
  label VARCHAR(100) NOT NULL,
  table_name VARCHAR(64) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS md_records (
  id VARCHAR(120) PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL REFERENCES md_entity_types(entity_type),
  code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  used_by JSONB NOT NULL DEFAULT '[]'::jsonb,
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT md_records_entity_code_unique UNIQUE (entity_type, code)
);

CREATE INDEX IF NOT EXISTS idx_md_records_entity_type ON md_records(entity_type);
CREATE INDEX IF NOT EXISTS idx_md_records_status ON md_records(status);
CREATE INDEX IF NOT EXISTS idx_md_records_version_status ON md_records(version_status);
CREATE INDEX IF NOT EXISTS idx_md_records_effective ON md_records(effective_from, effective_to);

CREATE TABLE IF NOT EXISTS md_record_history (
  history_id SERIAL PRIMARY KEY,
  record_id VARCHAR(120) NOT NULL REFERENCES md_records(id) ON DELETE CASCADE,
  entity_type VARCHAR(50) NOT NULL,
  version NUMERIC(5, 1) NOT NULL,
  status VARCHAR(20) NOT NULL,
  changed_by VARCHAR(255),
  reason TEXT,
  changed_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_md_record_history_record ON md_record_history(record_id);

CREATE TABLE IF NOT EXISTS md_enterprise_audit (
  audit_id VARCHAR(120) PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  module VARCHAR(100) NOT NULL,
  entity VARCHAR(100),
  entity_id VARCHAR(120),
  action TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT,
  user_name VARCHAR(255),
  user_role VARCHAR(100),
  correlation_id VARCHAR(120),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_md_audit_entity ON md_enterprise_audit(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_md_audit_created ON md_enterprise_audit(created_on DESC);

-- Entity registry (35 logical master entities)
INSERT INTO md_entity_types (entity_type, domain_key, label, table_name) VALUES
  ('business_units', 'organization', 'Business Units', 'md_business_units'),
  ('departments', 'organization', 'Departments', 'md_departments'),
  ('cost_centers', 'organization', 'Cost Centers', 'md_cost_centers'),
  ('legal_entities', 'organization', 'Legal Entities', 'md_legal_entities'),
  ('delivery_units', 'organization', 'Delivery Units', 'md_delivery_units'),
  ('practice_areas', 'organization', 'Practice Areas', 'md_practice_areas'),
  ('grades', 'workforce', 'Grades', 'md_grades'),
  ('job_levels', 'workforce', 'Job Levels', 'md_job_levels'),
  ('designations', 'workforce', 'Designations', 'md_designations'),
  ('employment_types', 'workforce', 'Employment Types', 'md_employment_types'),
  ('position_types', 'workforce', 'Position Types', 'md_position_types'),
  ('workforce_categories', 'workforce', 'Workforce Categories', 'md_workforce_categories'),
  ('skills', 'recruitment', 'Skills', 'md_skills'),
  ('skill_categories', 'recruitment', 'Skill Categories', 'md_skill_categories'),
  ('interview_types', 'recruitment', 'Interview Types', 'md_interview_types'),
  ('interview_modes', 'recruitment', 'Interview Modes', 'md_interview_modes'),
  ('candidate_sources', 'recruitment', 'Candidate Sources', 'md_candidate_sources'),
  ('vendor_partners', 'recruitment', 'Vendor Partners', 'md_vendor_partners'),
  ('referral_programs', 'recruitment', 'Referral Programs', 'md_referral_programs'),
  ('countries', 'geography', 'Countries', 'md_countries'),
  ('states', 'geography', 'States', 'md_states'),
  ('cities', 'geography', 'Cities', 'md_cities'),
  ('work_locations', 'geography', 'Work Locations', 'md_work_locations'),
  ('regions', 'geography', 'Regions', 'md_regions'),
  ('time_zones', 'geography', 'Time Zones', 'md_time_zones'),
  ('currencies', 'financial', 'Currency', 'md_currencies'),
  ('salary_bands', 'financial', 'Salary Bands', 'md_salary_bands'),
  ('budget_categories', 'financial', 'Budget Categories', 'md_budget_categories'),
  ('cost_types', 'financial', 'Cost Types', 'md_cost_types'),
  ('document_types', 'system', 'Document Types', 'md_document_types'),
  ('notification_templates', 'system', 'Notification Templates', 'md_notification_templates'),
  ('email_templates', 'system', 'Email Templates', 'md_email_templates'),
  ('offer_templates', 'system', 'Offer Templates', 'md_offer_templates'),
  ('calendar_types', 'system', 'Calendar Types', 'md_calendar_types'),
  ('holiday_calendars', 'system', 'Holiday Calendars', 'md_holiday_calendars')
ON CONFLICT (entity_type) DO NOTHING;

-- Per-entity views (normalized logical tables over md_records)
DO $$
DECLARE
  entity_key TEXT;
BEGIN
  FOREACH entity_key IN ARRAY ARRAY[
    'business_units','departments','cost_centers','legal_entities','delivery_units','practice_areas',
    'grades','job_levels','designations','employment_types','position_types','workforce_categories',
    'skills','skill_categories','interview_types','interview_modes','candidate_sources','vendor_partners','referral_programs',
    'countries','states','cities','work_locations','regions','time_zones',
    'currencies','salary_bands','budget_categories','cost_types',
    'document_types','notification_templates','email_templates','offer_templates','calendar_types','holiday_calendars'
  ]
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE VIEW md_%I AS SELECT * FROM md_records WHERE entity_type = %L AND is_deleted = FALSE',
      entity_key,
      entity_key
    );
  END LOOP;
END $$;

COMMIT;
