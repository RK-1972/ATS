-- OPTALYNX Enterprise Master Data — Skills Skill Category reference
-- Run: npm run migrate:master-data

BEGIN;

ALTER TABLE md_records
  ADD COLUMN IF NOT EXISTS skill_category_code VARCHAR(100);

UPDATE md_records
SET skill_category_code = 'SC-TECH'
WHERE entity_type = 'skills'
  AND (skill_category_code IS NULL OR skill_category_code = '');

ALTER TABLE md_records
  DROP CONSTRAINT IF EXISTS md_records_skills_category_required;

ALTER TABLE md_records
  ADD CONSTRAINT md_records_skills_category_required
  CHECK (
    entity_type <> 'skills'
    OR (skill_category_code IS NOT NULL AND skill_category_code <> '')
  );

CREATE INDEX IF NOT EXISTS idx_md_records_skill_category
  ON md_records(skill_category_code)
  WHERE entity_type = 'skills';

CREATE OR REPLACE VIEW md_skills AS
SELECT
  r.*,
  cat.name AS skill_category_name
FROM md_records r
LEFT JOIN md_records cat
  ON cat.entity_type = 'skill_categories'
  AND cat.code = r.skill_category_code
  AND cat.is_deleted = FALSE
WHERE r.entity_type = 'skills'
  AND r.is_deleted = FALSE;

COMMIT;
