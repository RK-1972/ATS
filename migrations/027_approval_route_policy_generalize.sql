-- OPTALYNX Enterprise Approval Route Policy — Migration 027
-- Generalize Phase 1 Budget-named columns for document-agnostic routing.
-- Scope ONLY:
--   1. Rename minimum_budget / maximum_budget → min_amount / max_amount
--   2. Make routing criteria nullable (NULL = wildcard)

BEGIN;

ALTER TABLE approval_route_policy
  ALTER COLUMN department DROP NOT NULL,
  ALTER COLUMN designation DROP NOT NULL,
  ALTER COLUMN grade DROP NOT NULL;

ALTER TABLE approval_route_policy
  RENAME COLUMN minimum_budget TO min_amount;

ALTER TABLE approval_route_policy
  RENAME COLUMN maximum_budget TO max_amount;

ALTER TABLE approval_route_policy
  DROP CONSTRAINT IF EXISTS chk_approval_route_policy_budget_range;

ALTER TABLE approval_route_policy
  ADD CONSTRAINT chk_approval_route_policy_amount_range
  CHECK (
    (min_amount IS NULL OR min_amount >= 0)
    AND (
      max_amount IS NULL
      OR min_amount IS NULL
      OR max_amount >= min_amount
    )
  );

DROP INDEX IF EXISTS idx_approval_route_policy_lookup;

CREATE INDEX IF NOT EXISTS idx_approval_route_policy_lookup
  ON approval_route_policy (
    LOWER(department),
    LOWER(designation),
    LOWER(grade),
    is_active,
    effective_from,
    effective_to
  );

COMMIT;
