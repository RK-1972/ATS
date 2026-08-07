-- OPTALYNX Compensation Engine Foundation — Sprint 12.2.1
-- Run: psql -U <user> -d <database> -f migrations/033_compensation_engine_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS cm_compensation_component_master (
  component_id VARCHAR(50) PRIMARY KEY,
  component_code VARCHAR(50) NOT NULL UNIQUE,
  component_name VARCHAR(100) NOT NULL,
  component_category VARCHAR(50) NOT NULL,
  display_order INT NOT NULL DEFAULT 1,
  default_formula_type VARCHAR(50),
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cm_compensation_structures (
  structure_id VARCHAR(50) PRIMARY KEY,
  structure_code VARCHAR(50) NOT NULL UNIQUE,
  structure_name VARCHAR(255) NOT NULL,
  description TEXT,
  effective_from DATE,
  effective_to DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_cm_compensation_structures_status
  ON cm_compensation_structures(status);

CREATE TABLE IF NOT EXISTS cm_compensation_structure_components (
  structure_component_id VARCHAR(50) PRIMARY KEY,
  structure_id VARCHAR(50) NOT NULL
    REFERENCES cm_compensation_structures(structure_id) ON DELETE CASCADE,
  component_id VARCHAR(50) NOT NULL
    REFERENCES cm_compensation_component_master(component_id) ON DELETE CASCADE,
  display_order INT NOT NULL DEFAULT 1,
  formula_type VARCHAR(50) NOT NULL,
  formula_value NUMERIC(14, 4),
  fixed_amount NUMERIC(14, 2),
  editable BOOLEAN NOT NULL DEFAULT FALSE,
  mandatory BOOLEAN NOT NULL DEFAULT FALSE,
  include_in_ctc BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(structure_id, component_id)
);

CREATE INDEX IF NOT EXISTS idx_cm_structure_components_structure
  ON cm_compensation_structure_components(structure_id);

-- =====================================================
-- Seed: Master Components
-- =====================================================

INSERT INTO cm_compensation_component_master (
  component_id, component_code, component_name, component_category,
  display_order, default_formula_type, description, status
) VALUES
  ('COMP-BASIC-DA', 'BASIC_DA', 'Basic + DA', 'EARNINGS', 1, 'PERCENT_OF_CTC', 'Basic salary including dearness allowance', 'Active'),
  ('COMP-HRA', 'HRA', 'HRA', 'EARNINGS', 2, 'PERCENT_OF_BASIC', 'House rent allowance', 'Active'),
  ('COMP-EMP-PF', 'EMPLOYER_PF', 'Employer PF', 'EMPLOYER_CONTRIBUTION', 3, 'PERCENT_OF_BASIC', 'Employer provident fund contribution', 'Active'),
  ('COMP-EMP-ESI', 'EMPLOYER_ESI', 'Employer ESI', 'EMPLOYER_CONTRIBUTION', 4, 'PERCENT_OF_CTC', 'Employer ESI contribution', 'Active'),
  ('COMP-GRATUITY', 'GRATUITY', 'Gratuity', 'EMPLOYER_CONTRIBUTION', 5, 'PERCENT_OF_BASIC', 'Employer gratuity provision', 'Active'),
  ('COMP-MEDICAL', 'MEDICAL_ALLOWANCE', 'Medical Allowance', 'ALLOWANCE', 6, 'FIXED', 'Medical reimbursement allowance', 'Active'),
  ('COMP-BONUS', 'BONUS', 'Bonus', 'BONUS', 7, 'FIXED', 'Annual bonus component', 'Active'),
  ('COMP-VARIABLE', 'VARIABLE_PAY', 'Variable Pay', 'VARIABLE', 8, 'PERCENT_OF_CTC', 'Variable performance pay', 'Active'),
  ('COMP-RETENTION', 'RETENTION_BONUS', 'Retention Bonus', 'BONUS', 9, 'FIXED', 'Retention bonus component', 'Active'),
  ('COMP-SPECIAL', 'SPECIAL_ALLOWANCE', 'Special Allowance', 'ALLOWANCE', 10, 'BALANCING', 'Balancing special allowance', 'Active')
ON CONFLICT (component_id) DO NOTHING;

-- =====================================================
-- Seed: Standard Karnataka Structure
-- =====================================================

INSERT INTO cm_compensation_structures (
  structure_id,
  structure_code,
  structure_name,
  description,
  effective_from,
  status,
  is_default,
  created_by,
  modified_by
) VALUES (
  'STRUCT-STANDARD-KARNATAKA',
  'STANDARD_KARNATAKA',
  'Standard Karnataka',
  'Default compensation structure for Karnataka offers.',
  CURRENT_DATE,
  'Active',
  TRUE,
  'system',
  'system'
)
ON CONFLICT (structure_id) DO NOTHING;

INSERT INTO cm_compensation_structure_components (
  structure_component_id,
  structure_id,
  component_id,
  display_order,
  formula_type,
  formula_value,
  fixed_amount,
  editable,
  mandatory,
  include_in_ctc,
  status
) VALUES
  ('SC-SK-001', 'STRUCT-STANDARD-KARNATAKA', 'COMP-BASIC-DA', 1, 'PERCENT_OF_CTC', 40.0000, NULL, FALSE, TRUE, TRUE, 'Active'),
  ('SC-SK-002', 'STRUCT-STANDARD-KARNATAKA', 'COMP-HRA', 2, 'PERCENT_OF_BASIC', 40.0000, NULL, FALSE, TRUE, TRUE, 'Active'),
  ('SC-SK-003', 'STRUCT-STANDARD-KARNATAKA', 'COMP-EMP-PF', 3, 'PERCENT_OF_BASIC', 12.0000, NULL, FALSE, TRUE, TRUE, 'Active'),
  ('SC-SK-004', 'STRUCT-STANDARD-KARNATAKA', 'COMP-EMP-ESI', 4, 'PERCENT_OF_CTC', 3.2500, NULL, FALSE, FALSE, TRUE, 'Active'),
  ('SC-SK-005', 'STRUCT-STANDARD-KARNATAKA', 'COMP-GRATUITY', 5, 'PERCENT_OF_BASIC', 4.8100, NULL, FALSE, FALSE, TRUE, 'Active'),
  ('SC-SK-006', 'STRUCT-STANDARD-KARNATAKA', 'COMP-MEDICAL', 6, 'FIXED', NULL, 15000.00, TRUE, FALSE, TRUE, 'Active'),
  ('SC-SK-007', 'STRUCT-STANDARD-KARNATAKA', 'COMP-BONUS', 7, 'RULE_BASED', NULL, NULL, FALSE, FALSE, TRUE, 'Active'),
  ('SC-SK-008', 'STRUCT-STANDARD-KARNATAKA', 'COMP-VARIABLE', 8, 'PERCENT_OF_CTC', 10.0000, NULL, FALSE, FALSE, TRUE, 'Active'),
  ('SC-SK-009', 'STRUCT-STANDARD-KARNATAKA', 'COMP-RETENTION', 9, 'FIXED', NULL, 0.00, TRUE, FALSE, FALSE, 'Active'),
  ('SC-SK-010', 'STRUCT-STANDARD-KARNATAKA', 'COMP-SPECIAL', 10, 'BALANCING', NULL, NULL, FALSE, FALSE, TRUE, 'Active')
ON CONFLICT (structure_component_id) DO NOTHING;

COMMIT;
