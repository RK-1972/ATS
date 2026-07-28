-- OPTALYNX — store selected Approval Route on requisition create.
-- Idempotent column add only; no workflow/history tables.

BEGIN;

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS approval_route_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_rm_requisitions_approval_route'
      AND conrelid = 'rm_requisitions'::regclass
  ) THEN
    ALTER TABLE rm_requisitions
      ADD CONSTRAINT fk_rm_requisitions_approval_route
      FOREIGN KEY (approval_route_id)
      REFERENCES approval_route_mstr (route_id)
      ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE req_mstr
  ADD COLUMN IF NOT EXISTS approval_route_id BIGINT;

COMMIT;
