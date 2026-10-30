-- OPTALYNX — Enterprise Talent Administrator platform role visibility (Enhancement #4 Phase 2).
-- Idempotent: inserts pc_role_visibility rows for the new role only; does not alter other roles.

BEGIN;

INSERT INTO pc_role_visibility (
  role_name,
  module_key,
  visible,
  version,
  version_status,
  created_by
)
SELECT
  v.role_name,
  v.module_key,
  v.visible,
  1.0,
  'Published',
  'System'
FROM (
  VALUES
    ('Enterprise Talent Administrator', 'recruitment', TRUE),
    ('Enterprise Talent Administrator', 'offer_management', FALSE),
    ('Enterprise Talent Administrator', 'interview_management', TRUE),
    ('Enterprise Talent Administrator', 'vendor_portal', FALSE),
    ('Enterprise Talent Administrator', 'ai', TRUE),
    ('Enterprise Talent Administrator', 'notifications', TRUE),
    ('Enterprise Talent Administrator', 'employee_referral', TRUE),
    ('Enterprise Talent Administrator', 'campus_hiring', FALSE)
) AS v(role_name, module_key, visible)
ON CONFLICT (role_name, module_key) DO NOTHING;

COMMIT;
