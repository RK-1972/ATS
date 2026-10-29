-- OPTALYNX — Release Offer work assignment (Enhancement #3).
-- Idempotent seed; does not grant employees access automatically.

BEGIN;

INSERT INTO work_assignment_mstr (
  assignment_code,
  assignment_name,
  business_module,
  description,
  is_active,
  created_by
) VALUES (
  'RELEASE_OFFER',
  'Release Offer',
  'Offer',
  'Authorized to release generated offers to the candidate portal.',
  TRUE,
  'System'
)
ON CONFLICT (assignment_code) DO NOTHING;

UPDATE work_assignment_mstr
SET
  category        = 'Offer',
  workspace_route = '/release-offer',
  workspace_icon  = 'SendOutlined',
  workspace_flag  = 'showReleaseOfferWorkspace',
  display_order   = 56,
  system_defined  = TRUE,
  updated_on      = NOW()
WHERE assignment_code = 'RELEASE_OFFER';

COMMIT;
