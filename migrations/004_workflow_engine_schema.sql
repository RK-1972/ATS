-- OPTALYNX Enterprise Workflow Engine — Schema Sprint 4
-- Run: psql -U <user> -d <database> -f migrations/004_workflow_engine_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS wf_config_state (
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

CREATE TABLE IF NOT EXISTS wf_bundle_snapshots (
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

CREATE TABLE IF NOT EXISTS wf_definitions (
  workflow_code VARCHAR(100) PRIMARY KEY,
  workflow_key VARCHAR(50) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100) NOT NULL DEFAULT 'Enterprise',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(20) NOT NULL DEFAULT 'Published',
  version_label VARCHAR(20) NOT NULL DEFAULT '1.0',
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  sla_hours INT NOT NULL DEFAULT 24,
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wf_stages (
  stage_id SERIAL PRIMARY KEY,
  workflow_code VARCHAR(100) NOT NULL REFERENCES wf_definitions(workflow_code) ON DELETE CASCADE,
  stage_key VARCHAR(100) NOT NULL,
  stage_name VARCHAR(255) NOT NULL,
  sequence_order INT NOT NULL DEFAULT 1,
  is_approval_stage BOOLEAN NOT NULL DEFAULT FALSE,
  sla_hours INT NOT NULL DEFAULT 24,
  responsible_role VARCHAR(255),
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  UNIQUE (workflow_code, stage_key)
);

CREATE TABLE IF NOT EXISTS wf_stage_transitions (
  transition_id SERIAL PRIMARY KEY,
  workflow_code VARCHAR(100) NOT NULL REFERENCES wf_definitions(workflow_code) ON DELETE CASCADE,
  from_stage_key VARCHAR(100) NOT NULL,
  to_stage_key VARCHAR(100) NOT NULL,
  action_name VARCHAR(50) NOT NULL DEFAULT 'advance',
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published'
);

CREATE TABLE IF NOT EXISTS wf_transition_conditions (
  condition_id SERIAL PRIMARY KEY,
  transition_id INT NOT NULL REFERENCES wf_stage_transitions(transition_id) ON DELETE CASCADE,
  expression TEXT NOT NULL,
  field_name VARCHAR(100),
  operator VARCHAR(30),
  field_value TEXT
);

CREATE TABLE IF NOT EXISTS wf_versions (
  version_id SERIAL PRIMARY KEY,
  workflow_code VARCHAR(100) NOT NULL REFERENCES wf_definitions(workflow_code) ON DELETE CASCADE,
  version_label VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Published',
  snapshot JSONB NOT NULL,
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  changed_by VARCHAR(255),
  changed_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT
);

CREATE TABLE IF NOT EXISTS wf_sla_definitions (
  sla_id SERIAL PRIMARY KEY,
  workflow_code VARCHAR(100) NOT NULL REFERENCES wf_definitions(workflow_code) ON DELETE CASCADE,
  stage_key VARCHAR(100),
  sla_hours INT NOT NULL DEFAULT 24,
  escalation_policy_key VARCHAR(100),
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published'
);

CREATE TABLE IF NOT EXISTS wf_escalation_policies (
  policy_key VARCHAR(100) PRIMARY KEY,
  workflow_code VARCHAR(100) NOT NULL REFERENCES wf_definitions(workflow_code) ON DELETE CASCADE,
  escalate_after_hours INT NOT NULL DEFAULT 48,
  escalate_to_role VARCHAR(255) NOT NULL,
  notification_template VARCHAR(255),
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published'
);

CREATE TABLE IF NOT EXISTS wf_instances (
  instance_id VARCHAR(100) PRIMARY KEY,
  workflow_code VARCHAR(100) NOT NULL REFERENCES wf_definitions(workflow_code),
  status VARCHAR(30) NOT NULL DEFAULT 'Running',
  current_stage_key VARCHAR(100),
  execution_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  instance_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  started_by VARCHAR(255),
  started_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_on TIMESTAMPTZ,
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_instances_workflow ON wf_instances(workflow_code);
CREATE INDEX IF NOT EXISTS idx_wf_instances_status ON wf_instances(status);

CREATE TABLE IF NOT EXISTS wf_tasks (
  task_id SERIAL PRIMARY KEY,
  instance_id VARCHAR(100) NOT NULL REFERENCES wf_instances(instance_id) ON DELETE CASCADE,
  stage_key VARCHAR(100) NOT NULL,
  task_type VARCHAR(50) NOT NULL DEFAULT 'approval',
  title VARCHAR(255) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  assignee VARCHAR(255),
  assignee_role VARCHAR(255),
  due_at TIMESTAMPTZ,
  completed_on TIMESTAMPTZ,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_tasks_instance ON wf_tasks(instance_id, status);

CREATE TABLE IF NOT EXISTS wf_assignments (
  assignment_id SERIAL PRIMARY KEY,
  task_id INT NOT NULL REFERENCES wf_tasks(task_id) ON DELETE CASCADE,
  assignee VARCHAR(255) NOT NULL,
  assignee_role VARCHAR(255),
  assigned_by VARCHAR(255),
  assigned_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS wf_history (
  history_id SERIAL PRIMARY KEY,
  instance_id VARCHAR(100) NOT NULL REFERENCES wf_instances(instance_id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  stage_key VARCHAR(100),
  actor VARCHAR(255),
  actor_role VARCHAR(255),
  action TEXT NOT NULL,
  comments TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_history_instance ON wf_history(instance_id, recorded_on DESC);

COMMIT;
