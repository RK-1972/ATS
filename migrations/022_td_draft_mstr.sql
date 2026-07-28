-- OPTALYNX Enterprise Talent Demand Draft Module — Phase 1
-- Private WIP documents only; not operational requisitions.
-- No seed data.

BEGIN;

CREATE TABLE IF NOT EXISTS td_draft_mstr (
  draft_id BIGSERIAL PRIMARY KEY,
  draft_code VARCHAR(50) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  owner_employee_code VARCHAR(100) NOT NULL,
  created_by VARCHAR(100) NOT NULL,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(100),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_by VARCHAR(100),
  deleted_on TIMESTAMPTZ,
  row_version INT NOT NULL DEFAULT 1,

  -- Relationship fields
  approval_route_id BIGINT,
  approved_position_id VARCHAR(50),
  result_req_id INT,
  result_requisition_code VARCHAR(50),

  -- Talent Demand form business fields
  client_id INT,
  client_name VARCHAR(255),
  project_id INT,
  project_name VARCHAR(255),
  job_title VARCHAR(255),
  job_description TEXT,
  primary_skill VARCHAR(255),
  secondary_skill VARCHAR(255),
  experience_min NUMERIC(6, 2),
  experience_max NUMERIC(6, 2),
  openings_count INT DEFAULT 1,
  work_location VARCHAR(255),
  employment_type VARCHAR(50),
  priority_level VARCHAR(50),
  hiring_manager_id INT,
  hiring_manager VARCHAR(255),
  target_date DATE,
  recruiter_id VARCHAR(100),

  CONSTRAINT uq_td_draft_mstr_draft_code UNIQUE (draft_code),
  CONSTRAINT fk_td_draft_mstr_approval_route
    FOREIGN KEY (approval_route_id)
    REFERENCES approval_route_mstr (route_id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_td_draft_mstr_draft_code
  ON td_draft_mstr (draft_code);

CREATE INDEX IF NOT EXISTS idx_td_draft_mstr_owner_employee_code
  ON td_draft_mstr (owner_employee_code);

CREATE INDEX IF NOT EXISTS idx_td_draft_mstr_status
  ON td_draft_mstr (status);

CREATE INDEX IF NOT EXISTS idx_td_draft_mstr_updated_on
  ON td_draft_mstr (updated_on);

COMMIT;
