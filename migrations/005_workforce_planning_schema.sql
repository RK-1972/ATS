-- OPTALYNX Workforce Planning — Schema Sprint 5
-- Run: psql -U <user> -d <database> -f migrations/005_workforce_planning_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS wp_config_state (
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

CREATE TABLE IF NOT EXISTS wp_bundle_snapshots (
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

CREATE TABLE IF NOT EXISTS wp_workforce_plans (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  fiscal_year VARCHAR(20) NOT NULL,
  org_name VARCHAR(255) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  last_updated TIMESTAMPTZ,
  created_by VARCHAR(255),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wp_budget_requests (
  request_id VARCHAR(50) PRIMARY KEY,
  department VARCHAR(255) NOT NULL,
  position_title VARCHAR(255) NOT NULL,
  grade VARCHAR(50),
  headcount INT NOT NULL DEFAULT 1,
  proposed_budget NUMERIC(14, 2) NOT NULL DEFAULT 0,
  justification TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'Draft',
  submitted_by VARCHAR(255),
  submitted_on DATE,
  priority VARCHAR(20) DEFAULT 'Medium',
  current_approver VARCHAR(255),
  workflow_instance_id VARCHAR(100),
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wp_budget_requests_status ON wp_budget_requests(status);

CREATE TABLE IF NOT EXISTS wp_position_requests (
  position_request_id VARCHAR(50) PRIMARY KEY,
  budget_request_id VARCHAR(50) REFERENCES wp_budget_requests(request_id) ON DELETE CASCADE,
  department VARCHAR(255) NOT NULL,
  position_title VARCHAR(255) NOT NULL,
  grade VARCHAR(50),
  headcount INT NOT NULL DEFAULT 1,
  status VARCHAR(50) NOT NULL DEFAULT 'Draft',
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wp_approved_positions (
  position_id VARCHAR(50) PRIMARY KEY,
  source_request_id VARCHAR(50) REFERENCES wp_budget_requests(request_id),
  department VARCHAR(255) NOT NULL,
  position_title VARCHAR(255) NOT NULL,
  grade VARCHAR(50),
  headcount INT NOT NULL DEFAULT 1,
  budget_approved NUMERIC(14, 2) NOT NULL DEFAULT 0,
  budget_consumed NUMERIC(14, 2) NOT NULL DEFAULT 0,
  remaining_budget NUMERIC(14, 2) NOT NULL DEFAULT 0,
  expiry_date DATE,
  requisitions_created INT NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'Active',
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  modified_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wp_budget_utilization (
  utilization_id SERIAL PRIMARY KEY,
  fiscal_year VARCHAR(20) NOT NULL,
  total_approved_budget NUMERIC(14, 2) NOT NULL DEFAULT 0,
  budget_consumed NUMERIC(14, 2) NOT NULL DEFAULT 0,
  budget_utilization_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
  savings NUMERIC(14, 2) NOT NULL DEFAULT 0,
  overspend NUMERIC(14, 2) NOT NULL DEFAULT 0,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wp_department_headcount (
  id SERIAL PRIMARY KEY,
  department VARCHAR(255) NOT NULL,
  approved_budget NUMERIC(14, 2) NOT NULL DEFAULT 0,
  utilized_budget NUMERIC(14, 2) NOT NULL DEFAULT 0,
  utilization_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
  approved_headcount INT NOT NULL DEFAULT 0,
  filled_positions INT NOT NULL DEFAULT 0,
  vacant_positions INT NOT NULL DEFAULT 0,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  UNIQUE (department, version)
);

CREATE TABLE IF NOT EXISTS wp_budget_exceptions (
  exception_id VARCHAR(50) PRIMARY KEY,
  candidate_name VARCHAR(255),
  position_title VARCHAR(255) NOT NULL,
  department VARCHAR(255) NOT NULL,
  approved_budget NUMERIC(14, 2) NOT NULL DEFAULT 0,
  offered_ctc NUMERIC(14, 2) NOT NULL DEFAULT 0,
  variance_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  variance_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
  workflow_status VARCHAR(50) NOT NULL DEFAULT 'Pending',
  approver VARCHAR(255),
  comments TEXT,
  req_code VARCHAR(50),
  workflow_instance_id VARCHAR(100),
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wp_position_lifecycle (
  lifecycle_id SERIAL PRIMARY KEY,
  position_id VARCHAR(50) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  from_status VARCHAR(50),
  to_status VARCHAR(50) NOT NULL,
  actor VARCHAR(255),
  comments TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wp_position_lifecycle_position
  ON wp_position_lifecycle(position_id, recorded_on DESC);

COMMIT;
