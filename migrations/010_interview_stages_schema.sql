-- OPTALYNX Enterprise Master Data — Interview Stages
-- Run: npm run migrate:master-data

BEGIN;

INSERT INTO md_entity_types (entity_type, domain_key, label, table_name) VALUES
  ('interview_stages', 'recruitment', 'Interview Stages', 'md_interview_stages')
ON CONFLICT (entity_type) DO NOTHING;

CREATE OR REPLACE VIEW md_interview_stages AS
SELECT *
FROM md_records
WHERE entity_type = 'interview_stages'
  AND is_deleted = FALSE;

COMMIT;
