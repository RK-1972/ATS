-- TA Lead workspace visibility via REQUISITION_ASSIGNER work assignment metadata.
-- Aligns with enterprise workspace resolver (showTaLeadWorkspace).

BEGIN;

UPDATE work_assignment_mstr
SET
  category = 'Requisition',
  workspace_route = '/ta-lead',
  workspace_icon = 'SupervisorAccountOutlined',
  workspace_flag = 'showTaLeadWorkspace',
  display_order = 30,
  system_defined = TRUE,
  updated_on = NOW()
WHERE assignment_code = 'REQUISITION_ASSIGNER';

COMMIT;
