-- OPTALYNX Enterprise Work Assignment Engine — seed BUDGET_REQUESTOR master.
-- Idempotent: does not alter existing rows, assignment IDs, or any authorization logic.
-- Phase 1: master catalog entry only. No employee mappings. No capability checks.

BEGIN;

INSERT INTO work_assignment_mstr (
  assignment_code,
  assignment_name,
  business_module,
  description,
  is_active,
  created_by
) VALUES (
  'BUDGET_REQUESTOR',
  'Budget Requestor',
  'Workforce Planning',
  'Authorized to raise and submit Workforce Planning Budget Requests.',
  TRUE,
  'System'
)
ON CONFLICT (assignment_code) DO NOTHING;

UPDATE work_assignment_mstr
SET
  category        = 'Workforce Planning',
  workspace_route = NULL,
  workspace_icon  = NULL,
  workspace_flag  = NULL,
  display_order   = 60,
  system_defined  = TRUE,
  updated_on      = NOW()
WHERE assignment_code = 'BUDGET_REQUESTOR';

COMMIT;
