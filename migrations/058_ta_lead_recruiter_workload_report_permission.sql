-- Grant TA Lead / TA Leader access to CANDIDATE_PIPELINE for RECRUITER_WORKLOAD standard report.
-- Run: psql -U <user> -d <database> -f migrations/058_ta_lead_recruiter_workload_report_permission.sql

BEGIN;

INSERT INTO rb_role_dataset_permission (role_name, dataset_id, can_view, can_export)
SELECT
  role_name,
  d.dataset_id,
  TRUE,
  TRUE
FROM rb_dataset d
CROSS JOIN (
  VALUES ('TA Lead'), ('TA Leader')
) AS roles(role_name)
WHERE d.code = 'CANDIDATE_PIPELINE'
ON CONFLICT (role_name, dataset_id) DO UPDATE
SET can_view = EXCLUDED.can_view,
    can_export = EXCLUDED.can_export;

INSERT INTO rb_role_field_permission (
  role_name, field_id, can_view, can_filter, can_sort, can_group
)
SELECT
  roles.role_name,
  f.field_id,
  TRUE,
  f.is_filterable,
  f.is_sortable,
  f.is_groupable
FROM rb_field f
INNER JOIN rb_dataset d ON d.dataset_id = f.dataset_id
CROSS JOIN (
  VALUES ('TA Lead'), ('TA Leader')
) AS roles(role_name)
WHERE d.code = 'CANDIDATE_PIPELINE'
  AND f.code IN (
    'assigned_recruiter_code',
    'assigned_recruiter_name',
    'candidate_id',
    'department',
    'applied_on'
  )
ON CONFLICT (role_name, field_id) DO UPDATE
SET can_view = EXCLUDED.can_view,
    can_filter = EXCLUDED.can_filter,
    can_sort = EXCLUDED.can_sort,
    can_group = EXCLUDED.can_group;

COMMIT;
