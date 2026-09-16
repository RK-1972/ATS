-- OPTALYNX Enterprise User Administration — immutable account status history.
-- Append-only audit trail for user_mstr.is_active changes and initial provisioning.

BEGIN;

CREATE TABLE IF NOT EXISTS user_status_history (
  history_id BIGSERIAL PRIMARY KEY,
  employee_code VARCHAR(100) NOT NULL,
  previous_status VARCHAR(20),
  new_status VARCHAR(20) NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by_employee_code VARCHAR(100),
  changed_by_name VARCHAR(255),
  reason TEXT,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_status_history_employee_effective
  ON user_status_history (employee_code, effective_at DESC);

COMMIT;
