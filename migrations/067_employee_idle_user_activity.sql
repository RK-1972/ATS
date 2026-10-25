-- Employee idle auto-logout V1 — authoritative user activity timestamp (distinct from telemetry last_seen_at).

BEGIN;

ALTER TABLE app_user_session
  ADD COLUMN IF NOT EXISTS last_user_activity_at TIMESTAMPTZ;

-- Do not seed from last_seen_at (telemetry/heartbeats); only login establishes initial genuine activity.
UPDATE app_user_session
SET last_user_activity_at = login_at
WHERE last_user_activity_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_app_user_session_idle_activity
  ON app_user_session (status, last_user_activity_at)
  WHERE status = 'ACTIVE';

COMMIT;
