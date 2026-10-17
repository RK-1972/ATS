-- Application Audit & Session History V1 — additive observability tables + work assignment seed.
-- Does not modify existing business tables or data.

BEGIN;

CREATE TABLE IF NOT EXISTS app_user_session (
  session_id UUID PRIMARY KEY,
  employee_code VARCHAR(50) NOT NULL,
  user_id INTEGER,
  email_id VARCHAR(255),
  login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  logout_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  source_ip VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  termination_reason VARCHAR(64),
  user_agent_summary VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_user_session_status_chk CHECK (
    status IN ('ACTIVE', 'LOGGED_OUT', 'EXPIRED', 'INTERRUPTED', 'REVOKED')
  )
);

CREATE INDEX IF NOT EXISTS idx_app_user_session_employee_login
  ON app_user_session (employee_code, login_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_user_session_status_login
  ON app_user_session (status, login_at DESC);

CREATE TABLE IF NOT EXISTS app_screen_activity (
  activity_id VARCHAR(120) PRIMARY KEY,
  session_id UUID REFERENCES app_user_session (session_id) ON DELETE SET NULL,
  employee_code VARCHAR(50) NOT NULL,
  screen_key VARCHAR(120) NOT NULL,
  route_template VARCHAR(255) NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL,
  exited_at TIMESTAMPTZ,
  last_visible_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_screen_activity_employee_entered
  ON app_screen_activity (employee_code, entered_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_screen_activity_session
  ON app_screen_activity (session_id, entered_at DESC);

INSERT INTO work_assignment_mstr (
  assignment_code,
  assignment_name,
  business_module,
  description,
  is_active,
  created_by
) VALUES (
  'APPLICATION_AUDIT_OBSERVER',
  'Application Audit Observer',
  'Security',
  'Authorized to review employee login sessions, screen activity, and enterprise business audit history.',
  TRUE,
  'System'
)
ON CONFLICT (assignment_code) DO NOTHING;

UPDATE work_assignment_mstr
SET
  category = 'Security',
  workspace_route = '/application-audit',
  workspace_icon = 'HistoryOutlined',
  workspace_flag = 'showApplicationAuditWorkspace',
  display_order = 6,
  system_defined = TRUE,
  updated_on = NOW()
WHERE assignment_code = 'APPLICATION_AUDIT_OBSERVER';

COMMIT;
