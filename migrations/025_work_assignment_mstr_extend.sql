-- OPTALYNX Enterprise Work Assignment Master — schema extension.
-- Adds Master metadata for UI + DB-driven Workspace Resolver.
-- Backward compatible: existing IDs preserved; seeded codes backfilled.

BEGIN;

ALTER TABLE work_assignment_mstr
  ADD COLUMN IF NOT EXISTS category VARCHAR(100);

ALTER TABLE work_assignment_mstr
  ADD COLUMN IF NOT EXISTS workspace_route VARCHAR(255);

ALTER TABLE work_assignment_mstr
  ADD COLUMN IF NOT EXISTS workspace_icon VARCHAR(100);

ALTER TABLE work_assignment_mstr
  ADD COLUMN IF NOT EXISTS workspace_flag VARCHAR(100);

ALTER TABLE work_assignment_mstr
  ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0;

ALTER TABLE work_assignment_mstr
  ADD COLUMN IF NOT EXISTS system_defined BOOLEAN NOT NULL DEFAULT FALSE;

-- Unique assignment name (case-insensitive), independent of PK ids.
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_assignment_mstr_assignment_name_lower
  ON work_assignment_mstr (LOWER(assignment_name));

CREATE INDEX IF NOT EXISTS idx_work_assignment_mstr_display_order
  ON work_assignment_mstr (display_order, assignment_code);

CREATE INDEX IF NOT EXISTS idx_work_assignment_mstr_workspace_flag
  ON work_assignment_mstr (workspace_flag)
  WHERE workspace_flag IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_assignment_mstr_system_defined
  ON work_assignment_mstr (system_defined);

-- Prevent duplicate active employee assignments (service already enforces).
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_work_assignment_active_pair
  ON employee_work_assignment (employee_code, work_assignment_id)
  WHERE is_active = TRUE;

-- Backfill existing system masters (match prior Login/Picker behaviour).
UPDATE work_assignment_mstr
SET
  category = 'Request',
  workspace_route = '/requisitions',
  workspace_icon = 'DescriptionOutlined',
  workspace_flag = 'showRequestWorkspace',
  display_order = 10,
  system_defined = TRUE,
  updated_on = NOW()
WHERE assignment_code = 'REQUISITION_REQUESTOR';

UPDATE work_assignment_mstr
SET
  category = 'Approval',
  workspace_route = '/my-approvals',
  workspace_icon = 'FactCheckOutlined',
  workspace_flag = 'showApprovalWorkspace',
  display_order = 20,
  system_defined = TRUE,
  updated_on = NOW()
WHERE assignment_code = 'REQUISITION_APPROVER';

UPDATE work_assignment_mstr
SET
  category = 'Requisition',
  workspace_route = NULL,
  workspace_icon = NULL,
  workspace_flag = NULL,
  display_order = 30,
  system_defined = TRUE,
  updated_on = NOW()
WHERE assignment_code = 'REQUISITION_ASSIGNER';

UPDATE work_assignment_mstr
SET
  category = 'Recruitment',
  workspace_route = '/recruiter',
  workspace_icon = 'DashboardOutlined',
  workspace_flag = 'showRecruitmentWorkspace',
  display_order = 40,
  system_defined = TRUE,
  updated_on = NOW()
WHERE assignment_code = 'RECRUITER';

UPDATE work_assignment_mstr
SET
  category = 'Interview',
  workspace_route = '/interviewer',
  workspace_icon = 'WorkOutlineOutlined',
  workspace_flag = 'showInterviewWorkspace',
  display_order = 50,
  system_defined = TRUE,
  updated_on = NOW()
WHERE assignment_code = 'INTERVIEWER';

COMMIT;
