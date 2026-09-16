-- Phase 4B — bind hiring_manager_mstr to user_mstr via employee_code.
-- Run: psql -U <user> -d <database> -f migrations/049_hiring_manager_employee_code_binding.sql

BEGIN;

ALTER TABLE hiring_manager_mstr
  ADD COLUMN IF NOT EXISTS employee_code VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_hiring_manager_mstr_employee_code
  ON hiring_manager_mstr (employee_code)
  WHERE employee_code IS NOT NULL AND is_active = TRUE;

-- Backfill employee_code from active Hiring Manager users matched by email.
UPDATE hiring_manager_mstr hm
SET employee_code = u.employee_code
FROM user_mstr u
WHERE hm.employee_code IS NULL
  AND hm.is_active = TRUE
  AND COALESCE(u.is_active, TRUE) = TRUE
  AND u.role_name = 'Hiring Manager'
  AND hm.email_id IS NOT NULL
  AND u.email_id IS NOT NULL
  AND LOWER(TRIM(hm.email_id)) = LOWER(TRIM(u.email_id));

-- Backfill rm_requisitions.hiring_manager_id from master name where still null.
UPDATE rm_requisitions r
SET hiring_manager_id = hm.hiring_manager_id,
    modified_on = NOW()
FROM hiring_manager_mstr hm
WHERE r.hiring_manager_id IS NULL
  AND r.hiring_manager IS NOT NULL
  AND hm.is_active = TRUE
  AND LOWER(TRIM(r.hiring_manager)) = LOWER(TRIM(hm.hiring_manager_name));

COMMIT;
