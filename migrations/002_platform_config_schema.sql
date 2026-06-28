-- OPTALYNX Platform Configuration Engine — Schema Sprint 2
-- Run: psql -U <user> -d <database> -f migrations/002_platform_config_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS pc_config_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  draft_payload JSONB NOT NULL,
  published_payload JSONB NOT NULL,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pc_config_snapshots (
  snapshot_id SERIAL PRIMARY KEY,
  version NUMERIC(5, 1) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Published',
  payload JSONB NOT NULL,
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_pc_config_snapshots_version
  ON pc_config_snapshots(version DESC);

CREATE TABLE IF NOT EXISTS pc_general_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  org_name VARCHAR(255) NOT NULL,
  environment VARCHAR(50) NOT NULL DEFAULT 'Production',
  last_published TIMESTAMPTZ,
  draft_changes INT NOT NULL DEFAULT 0,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pc_modules (
  module_key VARCHAR(50) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  depends_on VARCHAR(50),
  config_summary VARCHAR(255),
  policies INT NOT NULL DEFAULT 0,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pc_workflows (
  workflow_key VARCHAR(50) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  steps INT NOT NULL DEFAULT 0,
  approvals INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  version_label VARCHAR(20),
  sla_hours INT NOT NULL DEFAULT 24,
  stages JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_stages JSONB NOT NULL DEFAULT '[]'::jsonb,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pc_budget_governance (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  budget_approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  allow_offer_above_budget BOOLEAN NOT NULL DEFAULT FALSE,
  max_budget_variance_pct NUMERIC(5, 2) NOT NULL DEFAULT 10,
  exception_workflow_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  approval_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
  escalation_after_hours INT NOT NULL DEFAULT 48,
  escalation_to VARCHAR(255),
  auto_reject_above_pct NUMERIC(5, 2) NOT NULL DEFAULT 25,
  default_currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  default_headcount_buffer_pct NUMERIC(5, 2) NOT NULL DEFAULT 5,
  exception_approvers JSONB NOT NULL DEFAULT '[]'::jsonb,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pc_notification_channels (
  channel_key VARCHAR(50) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  provider VARCHAR(255),
  template_count INT NOT NULL DEFAULT 0,
  rate_limit_per_hour INT NOT NULL DEFAULT 100,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pc_notification_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  digest_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  digest_frequency VARCHAR(20) NOT NULL DEFAULT 'daily',
  digest_time VARCHAR(10) NOT NULL DEFAULT '08:00',
  quiet_hours_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  quiet_hours_start VARCHAR(10) NOT NULL DEFAULT '20:00',
  quiet_hours_end VARCHAR(10) NOT NULL DEFAULT '08:00',
  default_sender VARCHAR(255),
  retry_attempts INT NOT NULL DEFAULT 3,
  escalation_on_failure BOOLEAN NOT NULL DEFAULT TRUE,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pc_ai_features (
  feature_key VARCHAR(50) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  confidence_min NUMERIC(4, 2) NOT NULL DEFAULT 0.7,
  max_tokens INT NOT NULL DEFAULT 1000,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pc_ai_governance (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider VARCHAR(255),
  model VARCHAR(255),
  confidence_threshold NUMERIC(4, 2) NOT NULL DEFAULT 0.75,
  monthly_token_limit INT NOT NULL DEFAULT 500000,
  tokens_used INT NOT NULL DEFAULT 0,
  monthly_cost_cap_usd NUMERIC(10, 2) NOT NULL DEFAULT 500,
  cost_mtd_usd NUMERIC(10, 2) NOT NULL DEFAULT 0,
  audit_logging BOOLEAN NOT NULL DEFAULT TRUE,
  pii_masking BOOLEAN NOT NULL DEFAULT TRUE,
  require_human_confirmation BOOLEAN NOT NULL DEFAULT TRUE,
  data_retention_days INT NOT NULL DEFAULT 90,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pc_role_visibility (
  role_name VARCHAR(100) NOT NULL,
  module_key VARCHAR(50) NOT NULL,
  visible BOOLEAN NOT NULL DEFAULT FALSE,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_name, module_key)
);

CREATE TABLE IF NOT EXISTS pc_approval_policies (
  policy_id SERIAL PRIMARY KEY,
  policy_key VARCHAR(100) NOT NULL UNIQUE,
  policy_name VARCHAR(255) NOT NULL,
  approver_role VARCHAR(255) NOT NULL,
  sequence_order INT NOT NULL DEFAULT 1,
  policy_type VARCHAR(50) NOT NULL DEFAULT 'budget',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
