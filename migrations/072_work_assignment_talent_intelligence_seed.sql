-- OPTALYNX — Talent Intelligence workspace work assignment (OTI Phase 1).

BEGIN;

INSERT INTO work_assignment_mstr (
  assignment_code,
  assignment_name,
  business_module,
  description,
  is_active,
  created_by
) VALUES (
  'TALENT_INTELLIGENCE',
  'Talent Intelligence',
  'Recruitment',
  'Authorized to access the Talent Intelligence workspace for internal candidate sourcing.',
  TRUE,
  'System'
)
ON CONFLICT (assignment_code) DO NOTHING;

UPDATE work_assignment_mstr
SET
  category        = 'Recruitment',
  workspace_route = '/talent-intelligence',
  workspace_icon  = 'PersonSearchOutlined',
  workspace_flag  = 'showTalentIntelligenceWorkspace',
  display_order   = 58,
  system_defined  = TRUE,
  updated_on      = NOW()
WHERE assignment_code = 'TALENT_INTELLIGENCE';

COMMIT;
