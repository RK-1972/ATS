-- OPTALYNX Enterprise Work Assignment Engine — schema and seed masters.
-- New tables only; does not alter existing tables.
-- Seed: four work assignment role codes for requisition / recruiting.

BEGIN;

CREATE TABLE IF NOT EXISTS work_assignment_mstr (
  work_assignment_id BIGSERIAL PRIMARY KEY,
  assignment_code VARCHAR(50) NOT NULL,
  assignment_name VARCHAR(255) NOT NULL,
  business_module VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(100),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(100),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_work_assignment_mstr_assignment_code UNIQUE (assignment_code)
);

CREATE TABLE IF NOT EXISTS employee_work_assignment (
  employee_work_assignment_id BIGSERIAL PRIMARY KEY,
  employee_code VARCHAR(100) NOT NULL,
  work_assignment_id BIGINT NOT NULL,
  effective_from DATE,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(100),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(100),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_employee_work_assignment_work_assignment
    FOREIGN KEY (work_assignment_id)
    REFERENCES work_assignment_mstr (work_assignment_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_work_assignment_mstr_assignment_code
  ON work_assignment_mstr (assignment_code);

CREATE INDEX IF NOT EXISTS idx_work_assignment_mstr_business_module
  ON work_assignment_mstr (business_module);

CREATE INDEX IF NOT EXISTS idx_work_assignment_mstr_is_active
  ON work_assignment_mstr (is_active);

CREATE INDEX IF NOT EXISTS idx_employee_work_assignment_employee_code
  ON employee_work_assignment (employee_code);

CREATE INDEX IF NOT EXISTS idx_employee_work_assignment_work_assignment_id
  ON employee_work_assignment (work_assignment_id);

CREATE INDEX IF NOT EXISTS idx_employee_work_assignment_is_active
  ON employee_work_assignment (is_active);

CREATE INDEX IF NOT EXISTS idx_employee_work_assignment_effective
  ON employee_work_assignment (effective_from, effective_to);

INSERT INTO work_assignment_mstr (
  assignment_code,
  assignment_name,
  business_module,
  description,
  is_active,
  created_by
) VALUES
  (
    'REQUISITION_REQUESTOR',
    'Requisition Requestor',
    'Requisition',
    'Authorized to raise and submit Talent Demand / requisition requests.',
    TRUE,
    'System'
  ),
  (
    'REQUISITION_APPROVER',
    'Requisition Approver',
    'Requisition',
    'Authorized to approve or reject requisition approval tasks.',
    TRUE,
    'System'
  ),
  (
    'REQUISITION_ASSIGNER',
    'Requisition Assigner',
    'Requisition',
    'Authorized to assign recruiters to operational requisitions.',
    TRUE,
    'System'
  ),
  (
    'RECRUITER',
    'Recruiter',
    'Recruitment',
    'Authorized to execute recruiting work on assigned requisitions.',
    TRUE,
    'System'
  )
ON CONFLICT (assignment_code) DO NOTHING;

COMMIT;
