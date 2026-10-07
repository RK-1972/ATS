-- Employee lifecycle responsibility clearance (V1)
-- Emergency deactivation exceptions and open clearance tracking.

BEGIN;

CREATE TABLE IF NOT EXISTS employee_responsibility_clearance_exception (
  exception_id BIGSERIAL PRIMARY KEY,
  employee_code VARCHAR(100) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'Open',
  reason TEXT,
  created_by_employee_code VARCHAR(100),
  created_by_name VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_on TIMESTAMPTZ,
  resolved_by_employee_code VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chk_clearance_exception_status
    CHECK (status IN ('Open', 'Resolved'))
);

CREATE INDEX IF NOT EXISTS idx_clearance_exception_employee
  ON employee_responsibility_clearance_exception (employee_code);

CREATE INDEX IF NOT EXISTS idx_clearance_exception_status
  ON employee_responsibility_clearance_exception (status);

COMMIT;
