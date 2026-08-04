-- OPTALYNX Enterprise Work Assignment Engine — seed OFFER_RECRUITER master.
-- Idempotent: does not alter existing rows, assignment IDs, or authorization logic.
-- Mirrors RECRUITER / INTERVIEWER seed pattern with Offer Workspace metadata (025).

BEGIN;

INSERT INTO work_assignment_mstr (
  assignment_code,
  assignment_name,
  business_module,
  description,
  is_active,
  created_by
) VALUES (
  'OFFER_RECRUITER',
  'Offer Recruiter',
  'Offer',
  'Authorized to raise offer requests and work in the Offer Workspace.',
  TRUE,
  'System'
)
ON CONFLICT (assignment_code) DO NOTHING;

UPDATE work_assignment_mstr
SET
  category        = 'Offer',
  workspace_route = '/offers',
  workspace_icon  = 'LocalOfferOutlined',
  workspace_flag  = 'showOfferWorkspace',
  display_order   = 55,
  system_defined  = TRUE,
  updated_on      = NOW()
WHERE assignment_code = 'OFFER_RECRUITER';

COMMIT;
