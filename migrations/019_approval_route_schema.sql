-- OPTALYNX Enterprise Approval Route Management — reusable approval routes and steps.
-- Configuration schema only; no seed data.

BEGIN;

CREATE TABLE IF NOT EXISTS approval_route_mstr (
  route_id BIGSERIAL PRIMARY KEY,
  route_name VARCHAR(255) NOT NULL,
  description TEXT,
  applies_to VARCHAR(100) NOT NULL DEFAULT 'Requisition',
  status VARCHAR(50) NOT NULL DEFAULT 'Draft',
  effective_from DATE,
  max_approval_days INT NOT NULL DEFAULT 3,
  created_by VARCHAR(100),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(100),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_route_step (
  step_id BIGSERIAL PRIMARY KEY,
  route_id BIGINT NOT NULL REFERENCES approval_route_mstr (route_id) ON DELETE CASCADE,
  step_no INT NOT NULL,
  approver_employee_code VARCHAR(100),
  approval_type VARCHAR(100) NOT NULL DEFAULT 'Approval Required',
  comments_required BOOLEAN NOT NULL DEFAULT FALSE,
  allow_reject BOOLEAN NOT NULL DEFAULT TRUE,
  allow_return BOOLEAN NOT NULL DEFAULT TRUE,
  stop_if_rejected BOOLEAN NOT NULL DEFAULT TRUE,
  sequence_no INT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_route_step_route_id
  ON approval_route_step (route_id);

CREATE INDEX IF NOT EXISTS idx_approval_route_step_approver_employee_code
  ON approval_route_step (approver_employee_code);

CREATE INDEX IF NOT EXISTS idx_approval_route_step_sequence_no
  ON approval_route_step (sequence_no);

COMMIT;
