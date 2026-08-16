-- OPTALYNX Report Builder — Phase 2 Metadata Foundation
-- Governed metadata for adhoc reporting (CANDIDATE_PIPELINE, REQUISITION_SUMMARY).
-- sql_expression and base_view_key are backend-only; never exposed via API.
-- Run: node scripts/runMigrations.js (or apply this file via psql)

BEGIN;

-- ---------------------------------------------------------------------------
-- rb_dataset
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rb_dataset (
  dataset_id SERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  base_view_key VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT NOT NULL DEFAULT 0,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rb_dataset_code_unique UNIQUE (code)
);

CREATE INDEX IF NOT EXISTS idx_rb_dataset_active
  ON rb_dataset (is_active, display_order);

-- ---------------------------------------------------------------------------
-- rb_field
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rb_field (
  field_id SERIAL PRIMARY KEY,
  dataset_id INT NOT NULL REFERENCES rb_dataset (dataset_id) ON DELETE CASCADE,
  code VARCHAR(100) NOT NULL,
  label VARCHAR(255) NOT NULL,
  data_type VARCHAR(30) NOT NULL,
  sql_expression TEXT NOT NULL,
  is_filterable BOOLEAN NOT NULL DEFAULT FALSE,
  is_sortable BOOLEAN NOT NULL DEFAULT TRUE,
  is_groupable BOOLEAN NOT NULL DEFAULT FALSE,
  default_visible BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INT NOT NULL DEFAULT 0,
  enum_values JSONB,
  CONSTRAINT rb_field_dataset_code_unique UNIQUE (dataset_id, code),
  CONSTRAINT rb_field_data_type_check CHECK (
    data_type IN ('text', 'number', 'date', 'enum', 'reference')
  )
);

CREATE INDEX IF NOT EXISTS idx_rb_field_dataset
  ON rb_field (dataset_id, display_order);

-- ---------------------------------------------------------------------------
-- rb_filter
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rb_filter (
  filter_id SERIAL PRIMARY KEY,
  dataset_id INT NOT NULL REFERENCES rb_dataset (dataset_id) ON DELETE CASCADE,
  field_id INT NOT NULL REFERENCES rb_field (field_id) ON DELETE CASCADE,
  code VARCHAR(100) NOT NULL,
  label VARCHAR(255) NOT NULL,
  operator_type VARCHAR(30) NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INT NOT NULL DEFAULT 0,
  CONSTRAINT rb_filter_dataset_code_unique UNIQUE (dataset_id, code),
  CONSTRAINT rb_filter_operator_type_check CHECK (
    operator_type IN ('text', 'number', 'date', 'enum')
  )
);

CREATE INDEX IF NOT EXISTS idx_rb_filter_dataset
  ON rb_filter (dataset_id, display_order);

-- ---------------------------------------------------------------------------
-- rb_role_dataset_permission
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rb_role_dataset_permission (
  permission_id SERIAL PRIMARY KEY,
  role_name VARCHAR(100) NOT NULL,
  dataset_id INT NOT NULL REFERENCES rb_dataset (dataset_id) ON DELETE CASCADE,
  can_view BOOLEAN NOT NULL DEFAULT FALSE,
  can_export BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT rb_role_dataset_permission_unique UNIQUE (role_name, dataset_id)
);

CREATE INDEX IF NOT EXISTS idx_rb_role_dataset_permission_role
  ON rb_role_dataset_permission (role_name);

-- ---------------------------------------------------------------------------
-- rb_role_field_permission
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rb_role_field_permission (
  permission_id SERIAL PRIMARY KEY,
  role_name VARCHAR(100) NOT NULL,
  field_id INT NOT NULL REFERENCES rb_field (field_id) ON DELETE CASCADE,
  can_view BOOLEAN NOT NULL DEFAULT FALSE,
  can_filter BOOLEAN NOT NULL DEFAULT FALSE,
  can_sort BOOLEAN NOT NULL DEFAULT FALSE,
  can_group BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT rb_role_field_permission_unique UNIQUE (role_name, field_id)
);

CREATE INDEX IF NOT EXISTS idx_rb_role_field_permission_role
  ON rb_role_field_permission (role_name);

-- ---------------------------------------------------------------------------
-- Seed datasets
-- ---------------------------------------------------------------------------

INSERT INTO rb_dataset (code, name, description, base_view_key, display_order)
VALUES
  (
    'CANDIDATE_PIPELINE',
    'Candidate Pipeline',
    'Governed candidate-to-requisition pipeline dataset for adhoc reporting on candidates, requisitions, recruiters and hiring stages.',
    'candidate_pipeline_v1',
    10
  ),
  (
    'REQUISITION_SUMMARY',
    'Requisition Summary',
    'Governed requisition-level dataset for adhoc reporting on positions, departments, hiring managers, ownership, status and related attributes.',
    'requisition_summary_v1',
    20
  )
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed fields — CANDIDATE_PIPELINE
-- Grain: rm_candidate_mappings (enterprise pipeline SoR)
-- Candidate attributes: cand_mstr (legacy-only candidate master SoR)
-- Requisition attributes: rm_requisitions (enterprise requisition SoR)
-- Recruiter assignment: rm_recruiter_assignments + user_mstr
-- ---------------------------------------------------------------------------

INSERT INTO rb_field (
  dataset_id, code, label, data_type, sql_expression,
  is_filterable, is_sortable, is_groupable, default_visible, display_order, enum_values
)
SELECT
  d.dataset_id,
  v.code,
  v.label,
  v.data_type,
  v.sql_expression,
  v.is_filterable,
  v.is_sortable,
  v.is_groupable,
  v.default_visible,
  v.display_order,
  v.enum_values::jsonb
FROM rb_dataset d
CROSS JOIN (
  VALUES
    -- Pipeline mapping (rm_candidate_mappings m)
    ('mapping_id', 'Mapping ID', 'number', 'm.mapping_id', FALSE, TRUE, FALSE, FALSE, 10, NULL),
    ('map_id', 'Legacy Map ID', 'number', 'm.map_id', FALSE, TRUE, FALSE, FALSE, 20, NULL),
    ('requisition_code', 'Requisition Code', 'text', 'm.requisition_code', TRUE, TRUE, TRUE, TRUE, 30, NULL),
    ('stage_name', 'Pipeline Stage', 'enum', 'm.stage_name', TRUE, TRUE, TRUE, TRUE, 40, '["Applied","Screening","L1 Interview","L2 Interview","Client Interview","Offer","Joined"]'),
    ('source_type', 'Source Type', 'text', 'm.source_type', TRUE, TRUE, TRUE, FALSE, 50, NULL),
    ('applied_on', 'Applied On', 'date', 'm.applied_on', TRUE, TRUE, FALSE, TRUE, 60, NULL),
    ('modified_on', 'Last Modified On', 'date', 'm.modified_on', TRUE, TRUE, FALSE, FALSE, 70, NULL),
    ('mapping_recruiter_code', 'Mapping Recruiter Code', 'text', 'm.recruiter_id', TRUE, TRUE, TRUE, FALSE, 80, NULL),
    ('pipeline_remarks', 'Pipeline Remarks', 'text', 'm.remarks', TRUE, FALSE, FALSE, FALSE, 90, NULL),
    ('is_active', 'Active Mapping', 'enum', 'm.is_active', TRUE, TRUE, TRUE, FALSE, 100, '["true","false"]'),
    -- Candidate master (cand_mstr c)
    ('candidate_id', 'Candidate ID', 'number', 'c.candidate_id', FALSE, TRUE, FALSE, FALSE, 110, NULL),
    ('candidate_code', 'Candidate Code', 'text', 'c.candidate_code', TRUE, TRUE, TRUE, TRUE, 120, NULL),
    ('candidate_name', 'Candidate Name', 'text', 'CONCAT(c.first_name, '' '', c.last_name)', TRUE, TRUE, FALSE, TRUE, 130, NULL),
    ('first_name', 'First Name', 'text', 'c.first_name', TRUE, TRUE, FALSE, FALSE, 140, NULL),
    ('last_name', 'Last Name', 'text', 'c.last_name', TRUE, TRUE, FALSE, FALSE, 150, NULL),
    ('email_id', 'Email', 'text', 'c.email_id', TRUE, TRUE, FALSE, TRUE, 160, NULL),
    ('mobile_number', 'Mobile Number', 'text', 'c.mobile_number', TRUE, TRUE, FALSE, FALSE, 170, NULL),
    ('primary_skill', 'Candidate Primary Skill', 'text', 'c.primary_skill', TRUE, TRUE, TRUE, TRUE, 180, NULL),
    ('total_experience', 'Total Experience (Years)', 'number', 'c.total_experience', TRUE, TRUE, FALSE, FALSE, 190, NULL),
    ('candidate_status', 'Candidate Status', 'text', 'c.candidate_status', TRUE, TRUE, TRUE, TRUE, 200, NULL),
    ('source_channel', 'Source Channel', 'text', 'c.source_channel', TRUE, TRUE, TRUE, FALSE, 210, NULL),
    ('current_city', 'Current City', 'text', 'c.current_city', TRUE, TRUE, TRUE, FALSE, 220, NULL),
    ('current_state', 'Current State', 'text', 'c.current_state', TRUE, TRUE, TRUE, FALSE, 230, NULL),
    ('current_country', 'Current Country', 'text', 'c.current_country', TRUE, TRUE, TRUE, FALSE, 240, NULL),
    -- Requisition context (rm_requisitions r)
    ('position_title', 'Position Title', 'text', 'r.position_title', TRUE, TRUE, TRUE, TRUE, 250, NULL),
    ('department', 'Department', 'text', 'r.department', TRUE, TRUE, TRUE, TRUE, 260, NULL),
    ('grade', 'Grade', 'text', 'r.grade', TRUE, TRUE, TRUE, FALSE, 270, NULL),
    ('business_unit', 'Business Unit', 'text', 'r.business_unit', TRUE, TRUE, TRUE, FALSE, 280, NULL),
    ('location', 'Work Location', 'text', 'r.location', TRUE, TRUE, TRUE, FALSE, 290, NULL),
    ('hiring_manager', 'Hiring Manager', 'text', 'r.hiring_manager', TRUE, TRUE, TRUE, FALSE, 300, NULL),
    ('employment_type', 'Employment Type', 'text', 'r.employment_type', TRUE, TRUE, TRUE, FALSE, 310, NULL),
    ('req_status', 'Requisition Status', 'enum', 'r.req_status', TRUE, TRUE, TRUE, FALSE, 320, '["Open","Pending Level-1 Approval","Pending Level-2 Approval","Clarification Requested","Approved","Rejected","Pending TA Lead"]'),
    ('req_primary_skill', 'Requisition Primary Skill', 'text', 'r.primary_skill', TRUE, TRUE, TRUE, FALSE, 330, NULL),
    -- Recruiter assignment (rm_recruiter_assignments ra, user_mstr u)
    ('assigned_recruiter_code', 'Assigned Recruiter Code', 'text', 'ra.recruiter_code', TRUE, TRUE, TRUE, TRUE, 340, NULL),
    ('assigned_recruiter_name', 'Assigned Recruiter Name', 'text', 'u.full_name', TRUE, TRUE, FALSE, TRUE, 350, NULL)
) AS v(
  code, label, data_type, sql_expression,
  is_filterable, is_sortable, is_groupable, default_visible, display_order, enum_values
)
WHERE d.code = 'CANDIDATE_PIPELINE'
ON CONFLICT (dataset_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed fields — REQUISITION_SUMMARY
-- Grain: rm_requisitions (enterprise requisition SoR)
-- Approved position context: wp_approved_positions p
-- Recruiter assignment: rm_recruiter_assignments ra + user_mstr u
-- ---------------------------------------------------------------------------

INSERT INTO rb_field (
  dataset_id, code, label, data_type, sql_expression,
  is_filterable, is_sortable, is_groupable, default_visible, display_order, enum_values
)
SELECT
  d.dataset_id,
  v.code,
  v.label,
  v.data_type,
  v.sql_expression,
  v.is_filterable,
  v.is_sortable,
  v.is_groupable,
  v.default_visible,
  v.display_order,
  v.enum_values::jsonb
FROM rb_dataset d
CROSS JOIN (
  VALUES
    ('requisition_code', 'Requisition Code', 'text', 'r.requisition_code', TRUE, TRUE, TRUE, TRUE, 10, NULL),
    ('req_id', 'Legacy Req ID', 'number', 'r.req_id', FALSE, TRUE, FALSE, FALSE, 20, NULL),
    ('position_title', 'Position Title', 'text', 'r.position_title', TRUE, TRUE, TRUE, TRUE, 30, NULL),
    ('department', 'Department', 'text', 'r.department', TRUE, TRUE, TRUE, TRUE, 40, NULL),
    ('grade', 'Grade', 'text', 'r.grade', TRUE, TRUE, TRUE, TRUE, 50, NULL),
    ('business_unit', 'Business Unit', 'text', 'r.business_unit', TRUE, TRUE, TRUE, FALSE, 60, NULL),
    ('location', 'Work Location', 'text', 'r.location', TRUE, TRUE, TRUE, TRUE, 70, NULL),
    ('hiring_manager', 'Hiring Manager', 'text', 'r.hiring_manager', TRUE, TRUE, TRUE, TRUE, 80, NULL),
    ('employment_type', 'Employment Type', 'text', 'r.employment_type', TRUE, TRUE, TRUE, FALSE, 90, NULL),
    ('headcount', 'Headcount', 'number', 'r.headcount', TRUE, TRUE, FALSE, TRUE, 100, NULL),
    ('primary_skill', 'Primary Skill', 'text', 'r.primary_skill', TRUE, TRUE, TRUE, TRUE, 110, NULL),
    ('secondary_skill', 'Secondary Skill', 'text', 'r.secondary_skill', TRUE, TRUE, FALSE, FALSE, 120, NULL),
    ('req_status', 'Requisition Status', 'enum', 'r.req_status', TRUE, TRUE, TRUE, TRUE, 130, '["Open","Pending Level-1 Approval","Pending Level-2 Approval","Clarification Requested","Approved","Rejected","Pending TA Lead"]'),
    ('budget_approved', 'Budget Approved', 'number', 'r.budget_approved', TRUE, TRUE, FALSE, FALSE, 140, NULL),
    ('priority_level', 'Priority Level', 'text', 'r.priority_level', TRUE, TRUE, TRUE, FALSE, 150, NULL),
    ('target_date', 'Target Date', 'date', 'r.target_date', TRUE, TRUE, FALSE, FALSE, 160, NULL),
    ('experience_min', 'Minimum Experience', 'number', 'r.experience_min', TRUE, TRUE, FALSE, FALSE, 170, NULL),
    ('experience_max', 'Maximum Experience', 'number', 'r.experience_max', TRUE, TRUE, FALSE, FALSE, 180, NULL),
    ('created_on', 'Created On', 'date', 'r.created_on', TRUE, TRUE, FALSE, TRUE, 190, NULL),
    ('modified_on', 'Modified On', 'date', 'r.modified_on', TRUE, TRUE, FALSE, FALSE, 200, NULL),
    ('created_by', 'Created By', 'text', 'r.created_by', TRUE, TRUE, TRUE, FALSE, 210, NULL),
    ('approved_position_id', 'Approved Position ID', 'text', 'r.approved_position_id', TRUE, TRUE, TRUE, FALSE, 220, NULL),
    ('approved_position_title', 'Approved Position Title', 'text', 'p.position_title', TRUE, TRUE, TRUE, FALSE, 230, NULL),
    ('approved_department', 'Approved Department', 'text', 'p.department', TRUE, TRUE, TRUE, FALSE, 240, NULL),
    ('approved_grade', 'Approved Grade', 'text', 'p.grade', TRUE, TRUE, TRUE, FALSE, 250, NULL),
    ('assigned_recruiter_code', 'Assigned Recruiter Code', 'text', 'ra.recruiter_code', TRUE, TRUE, TRUE, TRUE, 260, NULL),
    ('assigned_recruiter_name', 'Assigned Recruiter Name', 'text', 'u.full_name', TRUE, TRUE, FALSE, TRUE, 270, NULL)
) AS v(
  code, label, data_type, sql_expression,
  is_filterable, is_sortable, is_groupable, default_visible, display_order, enum_values
)
WHERE d.code = 'REQUISITION_SUMMARY'
ON CONFLICT (dataset_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed filters — CANDIDATE_PIPELINE
-- ---------------------------------------------------------------------------

INSERT INTO rb_filter (dataset_id, field_id, code, label, operator_type, is_required, display_order)
SELECT
  d.dataset_id,
  f.field_id,
  v.code,
  v.label,
  v.operator_type,
  v.is_required,
  v.display_order
FROM rb_dataset d
INNER JOIN rb_field f
  ON f.dataset_id = d.dataset_id
CROSS JOIN (
  VALUES
    ('stage_name', 'stage_name', 'Pipeline Stage', 'enum', FALSE, 10),
    ('applied_on', 'applied_on', 'Applied On', 'date', FALSE, 20),
    ('requisition_code', 'requisition_code', 'Requisition Code', 'text', FALSE, 30),
    ('department', 'department', 'Department', 'text', FALSE, 40),
    ('position_title', 'position_title', 'Position Title', 'text', FALSE, 50),
    ('assigned_recruiter_code', 'assigned_recruiter_code', 'Assigned Recruiter', 'text', FALSE, 60),
    ('candidate_status', 'candidate_status', 'Candidate Status', 'text', FALSE, 70),
    ('req_status', 'req_status', 'Requisition Status', 'enum', FALSE, 80)
) AS v(code, field_code, label, operator_type, is_required, display_order)
WHERE d.code = 'CANDIDATE_PIPELINE'
  AND f.code = v.field_code
ON CONFLICT (dataset_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed filters — REQUISITION_SUMMARY
-- ---------------------------------------------------------------------------

INSERT INTO rb_filter (dataset_id, field_id, code, label, operator_type, is_required, display_order)
SELECT
  d.dataset_id,
  f.field_id,
  v.code,
  v.label,
  v.operator_type,
  v.is_required,
  v.display_order
FROM rb_dataset d
INNER JOIN rb_field f
  ON f.dataset_id = d.dataset_id
CROSS JOIN (
  VALUES
    ('req_status', 'req_status', 'Requisition Status', 'enum', FALSE, 10),
    ('department', 'department', 'Department', 'text', FALSE, 20),
    ('hiring_manager', 'hiring_manager', 'Hiring Manager', 'text', FALSE, 30),
    ('created_on', 'created_on', 'Created On', 'date', FALSE, 40),
    ('position_title', 'position_title', 'Position Title', 'text', FALSE, 50),
    ('grade', 'grade', 'Grade', 'text', FALSE, 60),
    ('assigned_recruiter_code', 'assigned_recruiter_code', 'Assigned Recruiter', 'text', FALSE, 70)
) AS v(code, field_code, label, operator_type, is_required, display_order)
WHERE d.code = 'REQUISITION_SUMMARY'
  AND f.code = v.field_code
ON CONFLICT (dataset_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed Admin permissions
-- ---------------------------------------------------------------------------

INSERT INTO rb_role_dataset_permission (role_name, dataset_id, can_view, can_export)
SELECT
  'Admin',
  d.dataset_id,
  TRUE,
  TRUE
FROM rb_dataset d
WHERE d.code IN ('CANDIDATE_PIPELINE', 'REQUISITION_SUMMARY')
ON CONFLICT (role_name, dataset_id) DO NOTHING;

INSERT INTO rb_role_field_permission (
  role_name, field_id, can_view, can_filter, can_sort, can_group
)
SELECT
  'Admin',
  f.field_id,
  TRUE,
  TRUE,
  TRUE,
  TRUE
FROM rb_field f
INNER JOIN rb_dataset d ON d.dataset_id = f.dataset_id
WHERE d.code IN ('CANDIDATE_PIPELINE', 'REQUISITION_SUMMARY')
ON CONFLICT (role_name, field_id) DO NOTHING;

COMMIT;
