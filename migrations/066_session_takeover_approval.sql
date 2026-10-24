-- Session takeover approval (V1): pending login when an ACTIVE employee session exists.

CREATE TABLE IF NOT EXISTS app_session_takeover_request (
  request_id UUID PRIMARY KEY,
  employee_code VARCHAR(32) NOT NULL,
  incumbent_session_id UUID NOT NULL REFERENCES app_user_session (session_id) ON DELETE CASCADE,
  status VARCHAR(24) NOT NULL,
  poll_token_hash CHAR(64) NOT NULL,
  requester_ip INET,
  requester_user_agent_summary VARCHAR(512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decision_by_session_id UUID REFERENCES app_user_session (session_id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  termination_reason VARCHAR(64),
  CONSTRAINT app_session_takeover_request_status_chk CHECK (
    status IN (
      'PENDING',
      'APPROVED',
      'DENIED',
      'EXPIRED',
      'CANCELLED',
      'COMPLETED'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_session_takeover_one_pending_per_employee
  ON app_session_takeover_request (employee_code)
  WHERE status = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_session_takeover_one_approved_per_employee
  ON app_session_takeover_request (employee_code)
  WHERE status = 'APPROVED';

CREATE INDEX IF NOT EXISTS idx_app_session_takeover_incumbent_pending
  ON app_session_takeover_request (incumbent_session_id, status)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_app_session_takeover_poll_hash
  ON app_session_takeover_request (poll_token_hash);

CREATE TABLE IF NOT EXISTS app_session_takeover_event (
  event_id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES app_session_takeover_request (request_id) ON DELETE CASCADE,
  employee_code VARCHAR(32) NOT NULL,
  event_type VARCHAR(48) NOT NULL,
  actor_session_id UUID,
  detail VARCHAR(256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_session_takeover_event_request
  ON app_session_takeover_event (request_id, created_at DESC);
