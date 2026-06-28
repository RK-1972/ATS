-- OPTALYNX Business Rules Engine — Schema Sprint 3
-- Run: psql -U <user> -d <database> -f migrations/003_business_rules_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS br_config_state (
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

CREATE TABLE IF NOT EXISTS br_bundle_snapshots (
  snapshot_id SERIAL PRIMARY KEY,
  version NUMERIC(5, 1) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Published',
  payload JSONB NOT NULL,
  description TEXT,
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_br_bundle_snapshots_version
  ON br_bundle_snapshots(version DESC);

CREATE TABLE IF NOT EXISTS br_general_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  org_name VARCHAR(255) NOT NULL,
  environment VARCHAR(50) NOT NULL DEFAULT 'Production',
  last_published TIMESTAMPTZ,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS br_categories (
  category_key VARCHAR(50) PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  rule_count INT NOT NULL DEFAULT 0,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS br_rules (
  rule_id VARCHAR(50) PRIMARY KEY,
  rule_code VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100) NOT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
  status VARCHAR(30) NOT NULL DEFAULT 'Draft',
  trigger_event VARCHAR(255),
  version VARCHAR(20) NOT NULL DEFAULT '0.1',
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  last_modified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_br_rules_status ON br_rules(status);
CREATE INDEX IF NOT EXISTS idx_br_rules_category ON br_rules(category);

CREATE TABLE IF NOT EXISTS br_rule_conditions (
  condition_id SERIAL PRIMARY KEY,
  rule_id VARCHAR(50) NOT NULL REFERENCES br_rules(rule_id) ON DELETE CASCADE,
  sequence_order INT NOT NULL DEFAULT 1,
  expression TEXT NOT NULL,
  field_name VARCHAR(100),
  operator VARCHAR(30),
  field_value TEXT,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_br_rule_conditions_rule ON br_rule_conditions(rule_id);

CREATE TABLE IF NOT EXISTS br_rule_actions (
  action_id SERIAL PRIMARY KEY,
  rule_id VARCHAR(50) NOT NULL REFERENCES br_rules(rule_id) ON DELETE CASCADE,
  sequence_order INT NOT NULL DEFAULT 1,
  action_type VARCHAR(50) NOT NULL DEFAULT 'generic',
  action_target VARCHAR(255),
  description TEXT NOT NULL,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_br_rule_actions_rule ON br_rule_actions(rule_id);

CREATE TABLE IF NOT EXISTS br_rule_parameters (
  parameter_id SERIAL PRIMARY KEY,
  rule_id VARCHAR(50) NOT NULL REFERENCES br_rules(rule_id) ON DELETE CASCADE,
  param_key VARCHAR(100) NOT NULL,
  param_value TEXT,
  param_type VARCHAR(50) NOT NULL DEFAULT 'string',
  required BOOLEAN NOT NULL DEFAULT FALSE,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rule_id, param_key)
);

CREATE TABLE IF NOT EXISTS br_rule_versions (
  version_id SERIAL PRIMARY KEY,
  rule_id VARCHAR(50) NOT NULL REFERENCES br_rules(rule_id) ON DELETE CASCADE,
  version_label VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Published',
  snapshot JSONB NOT NULL,
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  changed_by VARCHAR(255),
  changed_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_br_rule_versions_rule ON br_rule_versions(rule_id);

CREATE TABLE IF NOT EXISTS br_rule_dependencies (
  dependency_id SERIAL PRIMARY KEY,
  rule_id VARCHAR(50) NOT NULL REFERENCES br_rules(rule_id) ON DELETE CASCADE,
  depends_on_rule_id VARCHAR(50) NOT NULL REFERENCES br_rules(rule_id) ON DELETE CASCADE,
  dependency_type VARCHAR(50) NOT NULL DEFAULT 'requires',
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rule_id, depends_on_rule_id)
);

CREATE TABLE IF NOT EXISTS br_approval_matrix (
  matrix_id VARCHAR(50) PRIMARY KEY,
  department VARCHAR(255) NOT NULL,
  grade VARCHAR(50) NOT NULL,
  budget_limit_lpa NUMERIC(10, 2) NOT NULL DEFAULT 0,
  required_approvers JSONB NOT NULL DEFAULT '[]'::jsonb,
  escalation VARCHAR(255),
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS br_rule_execution_history (
  execution_id SERIAL PRIMARY KEY,
  rule_id VARCHAR(50),
  rule_code VARCHAR(100),
  execution_type VARCHAR(30) NOT NULL DEFAULT 'execute',
  matched BOOLEAN NOT NULL DEFAULT FALSE,
  execution_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  executed_by VARCHAR(255),
  executed_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  correlation_id VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_br_rule_execution_history_rule
  ON br_rule_execution_history(rule_id, executed_on DESC);

COMMIT;
