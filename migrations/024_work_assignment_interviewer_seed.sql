-- OPTALYNX Enterprise Work Assignment Engine — seed INTERVIEWER master.
-- Idempotent: does not alter existing rows or assignment IDs.

BEGIN;

INSERT INTO work_assignment_mstr (
  assignment_code,
  assignment_name,
  business_module,
  description,
  is_active,
  created_by
) VALUES (
  'INTERVIEWER',
  'Interviewer',
  'Interview',
  'Authorized to conduct interviews.',
  TRUE,
  'System'
)
ON CONFLICT (assignment_code) DO NOTHING;

COMMIT;
