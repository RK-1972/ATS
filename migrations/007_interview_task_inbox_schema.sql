-- OPTALYNX Interview Management + Enterprise Task Inbox — Schema Sprint 7
-- Run: psql -U <user> -d <database> -f migrations/007_interview_task_inbox_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS et_tasks (
  task_id SERIAL PRIMARY KEY,
  module VARCHAR(100) NOT NULL,
  task_type VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  priority VARCHAR(20) NOT NULL DEFAULT 'Normal',
  assignee VARCHAR(255),
  assignee_role VARCHAR(255),
  due_at TIMESTAMPTZ,
  sla_hours INT NOT NULL DEFAULT 24,
  escalated BOOLEAN NOT NULL DEFAULT FALSE,
  escalated_to VARCHAR(255),
  escalated_on TIMESTAMPTZ,
  workflow_instance_id VARCHAR(100),
  workflow_task_id INT,
  business_object_type VARCHAR(100),
  business_object_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  created_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_by VARCHAR(255),
  completed_on TIMESTAMPTZ,
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_et_tasks_assignee ON et_tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_et_tasks_assignee_role ON et_tasks(assignee_role);
CREATE INDEX IF NOT EXISTS idx_et_tasks_status ON et_tasks(status);
CREATE INDEX IF NOT EXISTS idx_et_tasks_workflow ON et_tasks(workflow_instance_id);
CREATE INDEX IF NOT EXISTS idx_et_tasks_business ON et_tasks(business_object_type, business_object_id);

CREATE TABLE IF NOT EXISTS et_task_history (
  history_id SERIAL PRIMARY KEY,
  task_id INT NOT NULL REFERENCES et_tasks(task_id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  from_status VARCHAR(30),
  to_status VARCHAR(30),
  actor VARCHAR(255),
  actor_role VARCHAR(100),
  comments TEXT,
  metadata JSONB,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS im_interviews (
  interview_id VARCHAR(50) PRIMARY KEY,
  schedule_id INT,
  map_id INT,
  req_id INT,
  requisition_code VARCHAR(50),
  candidate_id INT,
  round_no INT NOT NULL DEFAULT 1,
  round_type VARCHAR(100) NOT NULL,
  interview_date DATE NOT NULL,
  interview_time TIME NOT NULL,
  interview_status VARCHAR(50) NOT NULL DEFAULT 'Scheduled',
  workflow_instance_id VARCHAR(100),
  meeting_link TEXT,
  teams_event_id VARCHAR(255),
  remarks TEXT,
  feedback_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  final_outcome VARCHAR(100),
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  created_by VARCHAR(255),
  modified_by VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_im_interviews_status ON im_interviews(interview_status);
CREATE INDEX IF NOT EXISTS idx_im_interviews_schedule ON im_interviews(schedule_id);
CREATE INDEX IF NOT EXISTS idx_im_interviews_workflow ON im_interviews(workflow_instance_id);

CREATE TABLE IF NOT EXISTS im_panel_assignments (
  assignment_id SERIAL PRIMARY KEY,
  interview_id VARCHAR(50) NOT NULL REFERENCES im_interviews(interview_id) ON DELETE CASCADE,
  panel_id INT,
  interviewer_name VARCHAR(255),
  interviewer_email VARCHAR(255),
  interviewer_type VARCHAR(100),
  assignment_status VARCHAR(50) NOT NULL DEFAULT 'Pending',
  accepted_on TIMESTAMPTZ,
  reassigned_from INT,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ,
  assigned_by VARCHAR(255),
  assigned_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_im_panel_assignments_interview ON im_panel_assignments(interview_id);

CREATE TABLE IF NOT EXISTS im_feedback (
  feedback_id SERIAL PRIMARY KEY,
  interview_id VARCHAR(50) NOT NULL REFERENCES im_interviews(interview_id) ON DELETE CASCADE,
  schedule_id INT,
  interview_level VARCHAR(100),
  area_of_interview VARCHAR(255),
  overall_rating NUMERIC(3, 1),
  strengths TEXT,
  improvement_areas TEXT,
  overall_comments TEXT,
  final_outcome VARCHAR(100),
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  feedback_status VARCHAR(50) NOT NULL DEFAULT 'Submitted',
  submitted_by VARCHAR(255),
  submitted_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  version_status VARCHAR(20) NOT NULL DEFAULT 'Published',
  effective_from TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS im_interview_history (
  history_id SERIAL PRIMARY KEY,
  interview_id VARCHAR(50) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  from_status VARCHAR(50),
  to_status VARCHAR(50),
  actor VARCHAR(255),
  comments TEXT,
  metadata JSONB,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
