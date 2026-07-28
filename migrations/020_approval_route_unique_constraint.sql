-- OPTALYNX — unique Approval Route name per Applies To.
-- Idempotent: dedupe then ensure UNIQUE (applies_to, route_name).

BEGIN;

-- Keep the lowest route_id for each (applies_to, route_name); remove later duplicates.
-- Child steps are removed via ON DELETE CASCADE on approval_route_step.route_id.
DELETE FROM approval_route_mstr AS duplicate
USING approval_route_mstr AS keeper
WHERE duplicate.applies_to = keeper.applies_to
  AND duplicate.route_name = keeper.route_name
  AND duplicate.route_id > keeper.route_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_approval_route_applies_to_route_name'
      AND conrelid = 'approval_route_mstr'::regclass
  ) THEN
    ALTER TABLE approval_route_mstr
      ADD CONSTRAINT uq_approval_route_applies_to_route_name
      UNIQUE (applies_to, route_name);
  END IF;
END $$;

COMMIT;
