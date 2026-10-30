-- OPTALYNX — Centralized Candidate Control Tower work assignment (Enhancement #4).
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
  'CANDIDATE_CONTROL_TOWER',
  'Centralized Candidate Control Tower',
  'Recruitment',
  'Authorized to access the centralized candidate pipeline control tower workspace.',
  TRUE,
  'System'
)
ON CONFLICT (assignment_code) DO NOTHING;

UPDATE work_assignment_mstr
SET
  category        = 'Recruitment',
  workspace_route = '/candidate-control-tower',
  workspace_icon  = 'RadarOutlined',
  workspace_flag  = 'showCandidateControlTowerWorkspace',
  display_order   = 57,
  system_defined  = TRUE,
  updated_on      = NOW()
WHERE assignment_code = 'CANDIDATE_CONTROL_TOWER';

COMMIT;
