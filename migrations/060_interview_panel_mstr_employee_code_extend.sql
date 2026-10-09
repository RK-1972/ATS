-- Align interview_panel_mstr.employee_code with enterprise employee identifiers.
-- Run: psql -U <user> -d <database> -f migrations/060_interview_panel_mstr_employee_code_extend.sql

BEGIN;

ALTER TABLE interview_panel_mstr
  ALTER COLUMN employee_code TYPE VARCHAR(100);

COMMIT;
