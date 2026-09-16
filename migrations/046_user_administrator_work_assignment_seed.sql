-- OPTALYNX Enterprise Work Assignment Engine — seed USER_ADMINISTRATOR master.
-- Idempotent: does not alter existing rows, assignment IDs, or authorization logic.

BEGIN;

INSERT INTO work_assignment_mstr (
  assignment_code,
  assignment_name,
  business_module,
  description,
  is_active,
  created_by
) VALUES (
  'USER_ADMINISTRATOR',
  'User Administrator',
  'Security',
  'Authorized to create employee accounts and assign operational work assignments.',
  TRUE,
  'System'
)
ON CONFLICT (assignment_code) DO NOTHING;

UPDATE work_assignment_mstr
SET
  category = 'Security',
  workspace_route = '/users',
  workspace_icon = 'PeopleAltOutlined',
  workspace_flag = 'showUserAdministrationWorkspace',
  display_order = 5,
  system_defined = TRUE,
  updated_on = NOW()
WHERE assignment_code = 'USER_ADMINISTRATOR';

COMMIT;
