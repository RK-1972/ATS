-- OPTALYNX Enterprise User Permissions — per-employee permission map.
-- Extensible permission_code model; initial code: RAISE_REQUISITION.

BEGIN;

CREATE TABLE IF NOT EXISTS user_permission_map (
  permission_map_id SERIAL PRIMARY KEY,
  employee_code VARCHAR(100) NOT NULL,
  permission_code VARCHAR(100) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by VARCHAR(100),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_permission_map_employee_permission_unique
    UNIQUE (employee_code, permission_code)
);

CREATE INDEX IF NOT EXISTS idx_user_permission_map_employee
  ON user_permission_map (employee_code);

CREATE INDEX IF NOT EXISTS idx_user_permission_map_permission
  ON user_permission_map (permission_code);

COMMIT;
