-- OPTALYNX Notification Orchestration — delivery attempt audit (Phase 6C-1)
-- Append-only audit of notification send attempts. No rendered bodies or secrets.

BEGIN;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id BIGSERIAL PRIMARY KEY,
  event_key VARCHAR(100) NOT NULL,
  recipient VARCHAR(255) NOT NULL,
  channel VARCHAR(50) NOT NULL,
  template_key VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  correlation_id VARCHAR(120),
  error_code VARCHAR(100),
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempted_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_on TIMESTAMPTZ,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_notification_deliveries_status
    CHECK (status IN ('Pending', 'Success', 'Failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_deliveries_correlation_id
  ON notification_deliveries (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_event_attempted
  ON notification_deliveries (event_key, attempted_on DESC);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient
  ON notification_deliveries (recipient);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status
  ON notification_deliveries (status);

COMMIT;
