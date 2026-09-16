-- OPTALYNX Enterprise User Administration — immutable Primary Role history.
-- Append-only audit trail for user_mstr.role_name changes and initial provisioning.

BEGIN;

CREATE TABLE IF NOT EXISTS user_role_history (
  history_id BIGSERIAL PRIMARY KEY,
  employee_code VARCHAR(100) NOT NULL,
  previous_role_name VARCHAR(100),
  new_role_name VARCHAR(100) NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by_employee_code VARCHAR(100),
  changed_by_name VARCHAR(255),
  reason TEXT,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_role_history_employee_effective
  ON user_role_history (employee_code, effective_at DESC);

COMMIT;
