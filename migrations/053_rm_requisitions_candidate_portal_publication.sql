-- OPTALYNX — Candidate Portal publication fields on rm_requisitions.
-- Approved requisitions require explicit publication before portal visibility.

BEGIN;

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS candidate_portal_published_at TIMESTAMPTZ;

ALTER TABLE rm_requisitions
  ADD COLUMN IF NOT EXISTS candidate_portal_published_by VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_rm_requisitions_portal_published
  ON rm_requisitions (req_status, candidate_portal_published_at)
  WHERE candidate_portal_published_at IS NOT NULL;

COMMIT;
