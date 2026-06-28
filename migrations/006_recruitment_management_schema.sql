-- OPTALYNX Recruitment Management — Schema Sprint 6
-- Run: psql -U <user> -d <database> -f migrations/006_recruitment_management_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS rm_requisitions (
  requisition_code VARCHAR(50) PRIMARY KEY,
  approved_position_id VARCHAR(50) REFERENCES wp_approved_positions(position_id),
  req_id INT,
  position_title VARCHAR(255) NOT NULL,
  grade VARCHAR(50),
  department VARCHAR(255) NOT NULL,
  business_unit VARCHAR(255),
  location VARCHAR(255),
  budget_approved NUMERIC(14, 2) NOT NULL DEFAULT 0,
  hiring_manager VARCHAR(255),
  employment_type VARCHAR(50) DEFAULT 'Full-time',
  headcount INT NOT NULL DEFAULT 1,
  primary_skill VARCHAR(255),
  req_status VARCHAR(50) NOT NULL DEFAULT 'Pending TA Lead',
  workflow_instance_id VARCHAR(100),
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by VARCHAR(255),
  modified_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rm_requisitions_position ON rm_requisitions(approved_position_id);
CREATE INDEX IF NOT EXISTS idx_rm_requisitions_status ON rm_requisitions(req_status);
CREATE INDEX IF NOT EXISTS idx_rm_requisitions_workflow ON rm_requisitions(workflow_instance_id);

CREATE TABLE IF NOT EXISTS rm_recruiter_assignments (
  assignment_id SERIAL PRIMARY KEY,
  requisition_code VARCHAR(50) NOT NULL REFERENCES rm_requisitions(requisition_code) ON DELETE CASCADE,
  req_id INT,
  recruiter_code VARCHAR(50) NOT NULL,
  assigned_by VARCHAR(255),
  workflow_task_id VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  assigned_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rm_recruiter_assignments_req ON rm_recruiter_assignments(requisition_code);

CREATE TABLE IF NOT EXISTS rm_candidate_mappings (
  mapping_id SERIAL PRIMARY KEY,
  candidate_id INT,
  candidate_code VARCHAR(50),
  requisition_code VARCHAR(50) NOT NULL REFERENCES rm_requisitions(requisition_code),
  req_id INT,
  map_id INT,
  recruiter_id VARCHAR(50),
  stage_name VARCHAR(100) NOT NULL DEFAULT 'Applied',
  source_type VARCHAR(100),
  workflow_instance_id VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  remarks TEXT,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  applied_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rm_candidate_mappings_req ON rm_candidate_mappings(requisition_code);
CREATE INDEX IF NOT EXISTS idx_rm_candidate_mappings_stage ON rm_candidate_mappings(stage_name);

CREATE TABLE IF NOT EXISTS rm_pipeline_history (
  history_id SERIAL PRIMARY KEY,
  requisition_code VARCHAR(50),
  mapping_id INT,
  candidate_id INT,
  event_type VARCHAR(100) NOT NULL,
  from_stage VARCHAR(100),
  to_stage VARCHAR(100),
  actor VARCHAR(255),
  actor_role VARCHAR(100),
  comments TEXT,
  metadata JSONB,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rm_pipeline_history_req ON rm_pipeline_history(requisition_code);

CREATE TABLE IF NOT EXISTS rm_requisition_snapshots (
  snapshot_id SERIAL PRIMARY KEY,
  requisition_code VARCHAR(50) NOT NULL,
  version NUMERIC(5, 1) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Published',
  payload JSONB NOT NULL,
  description TEXT,
  effective_from TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT
);

COMMIT;
