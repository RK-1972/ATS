-- OPTALYNX Approval Route Policy — multi-select designation / grade criteria
-- One policy row covers many designation × grade combinations (cross-product).
-- NULL or empty array = wildcard (match all), same semantics as NULL scalar columns.

BEGIN;

ALTER TABLE approval_route_policy
  ADD COLUMN IF NOT EXISTS designations TEXT[],
  ADD COLUMN IF NOT EXISTS grades TEXT[];

ALTER TABLE approval_route_policy
  ALTER COLUMN min_amount DROP NOT NULL;

UPDATE approval_route_policy
SET
  designations = CASE
    WHEN designation IS NOT NULL AND TRIM(designation) <> ''
      THEN ARRAY[TRIM(designation)]
    ELSE NULL
  END,
  grades = CASE
    WHEN grade IS NOT NULL AND TRIM(grade) <> ''
      THEN ARRAY[TRIM(grade)]
    ELSE NULL
  END
WHERE designations IS NULL
   OR grades IS NULL;

DROP INDEX IF EXISTS idx_approval_route_policy_lookup;

CREATE INDEX IF NOT EXISTS idx_approval_route_policy_lookup
  ON approval_route_policy (
    LOWER(department),
    is_active,
    effective_from,
    effective_to
  );

CREATE INDEX IF NOT EXISTS idx_approval_route_policy_designations_gin
  ON approval_route_policy
  USING GIN (designations);

CREATE INDEX IF NOT EXISTS idx_approval_route_policy_grades_gin
  ON approval_route_policy
  USING GIN (grades);

COMMIT;
