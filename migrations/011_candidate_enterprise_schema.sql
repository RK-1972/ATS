-- OPTALYNX Candidate Enterprise Domain — Phase 2
-- Extends legacy cand_mstr (all existing columns retained) + child profile tables.
-- Run: npm run migrate:candidate
-- Rollback: npm run rollback:candidate

BEGIN;

-- ---------------------------------------------------------------------------
-- cand_mstr — additive enterprise columns only (no drops, no renames)
-- Existing columns preserved: candidate_id, candidate_code, first_name, last_name,
-- email_id, pan_number, mobile_number, total_experience, relevant_experience,
-- current_company, current_ctc, expected_ctc, notice_period, current_location,
-- preferred_location, primary_skill, secondary_skill, linkedin_url, resume_path,
-- source_channel, candidate_status, recruiter_id, remarks, created_by, created_on,
-- updated_on
-- ---------------------------------------------------------------------------

ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS salutation VARCHAR(20);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS middle_name VARCHAR(100);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS preferred_name VARCHAR(150);

ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS gender VARCHAR(30);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS nationality VARCHAR(100);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS marital_status VARCHAR(30);

ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS alternate_email VARCHAR(255);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS alternate_mobile VARCHAR(30);

ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS current_designation VARCHAR(255);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS current_department VARCHAR(100);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS current_country VARCHAR(100);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS current_state VARCHAR(100);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS current_city VARCHAR(100);

ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS total_experience_years INT;
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS total_experience_months INT;
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS relevant_experience_years INT;
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS relevant_experience_months INT;

ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS currency_code VARCHAR(20);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS willing_to_relocate BOOLEAN DEFAULT FALSE;
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS preferred_work_mode VARCHAR(50);

ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS candidate_source_code VARCHAR(100);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS vendor_partner_code VARCHAR(100);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS referral_program_code VARCHAR(100);

ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS resume_document_id VARCHAR(100);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS resume_uploaded_on TIMESTAMPTZ;
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS profile_completion NUMERIC(5, 2) DEFAULT 0;

ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS modified_by VARCHAR(100);
ALTER TABLE cand_mstr ADD COLUMN IF NOT EXISTS active_flag BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_cand_mstr_active ON cand_mstr(active_flag);
CREATE INDEX IF NOT EXISTS idx_cand_mstr_source_code ON cand_mstr(candidate_source_code);
CREATE INDEX IF NOT EXISTS idx_cand_mstr_skill_primary ON cand_mstr(primary_skill);

-- ---------------------------------------------------------------------------
-- can_address — multiple addresses per candidate (EMD: city, state, country codes)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_address (
  address_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  address_type VARCHAR(50) NOT NULL DEFAULT 'Current',
  address_line_1 VARCHAR(255),
  address_line_2 VARCHAR(255),
  city_code VARCHAR(100),
  state_code VARCHAR(100),
  country_code VARCHAR(100),
  postal_code VARCHAR(20),
  active_flag BOOLEAN NOT NULL DEFAULT TRUE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_can_address_candidate ON can_address(candidate_id);

-- ---------------------------------------------------------------------------
-- can_education
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_education (
  education_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  qualification VARCHAR(255),
  institution VARCHAR(255),
  specialization VARCHAR(255),
  board_university VARCHAR(255),
  year_of_passing INT,
  percentage NUMERIC(5, 2),
  cgpa NUMERIC(4, 2),
  from_date DATE,
  to_date DATE,
  score_type VARCHAR(30),
  active_flag BOOLEAN NOT NULL DEFAULT TRUE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_can_education_candidate ON can_education(candidate_id);

-- Additive columns for existing can_education installs (CREATE IF NOT EXISTS is a no-op)
ALTER TABLE can_education ADD COLUMN IF NOT EXISTS from_date DATE;
ALTER TABLE can_education ADD COLUMN IF NOT EXISTS to_date DATE;
ALTER TABLE can_education ADD COLUMN IF NOT EXISTS score_type VARCHAR(30);

-- ---------------------------------------------------------------------------
-- can_experience
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_experience (
  experience_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  company_name VARCHAR(255),
  designation VARCHAR(255),
  joining_date DATE,
  relieving_date DATE,
  role_summary TEXT,
  technology TEXT,
  reason_for_change TEXT,
  active_flag BOOLEAN NOT NULL DEFAULT TRUE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_can_experience_candidate ON can_experience(candidate_id);

-- ---------------------------------------------------------------------------
-- can_skill_map — skill_code references Recruitment → Skills (EMD)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_skill_map (
  skill_map_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  skill_code VARCHAR(100) NOT NULL,
  experience_years INT DEFAULT 0,
  experience_months INT DEFAULT 0,
  proficiency VARCHAR(50),
  last_used DATE,
  active_flag BOOLEAN NOT NULL DEFAULT TRUE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id, skill_code)
);

CREATE INDEX IF NOT EXISTS idx_can_skill_map_candidate ON can_skill_map(candidate_id);
CREATE INDEX IF NOT EXISTS idx_can_skill_map_skill ON can_skill_map(skill_code);

-- ---------------------------------------------------------------------------
-- can_certification
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_certification (
  certification_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  certification_name VARCHAR(255) NOT NULL,
  issuing_authority VARCHAR(255),
  issued_date DATE,
  expiry_date DATE,
  credential_id VARCHAR(255),
  active_flag BOOLEAN NOT NULL DEFAULT TRUE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_can_certification_candidate ON can_certification(candidate_id);

-- ---------------------------------------------------------------------------
-- can_language
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_language (
  language_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  language VARCHAR(100) NOT NULL,
  read_flag BOOLEAN NOT NULL DEFAULT FALSE,
  write_flag BOOLEAN NOT NULL DEFAULT FALSE,
  speak_flag BOOLEAN NOT NULL DEFAULT FALSE,
  active_flag BOOLEAN NOT NULL DEFAULT TRUE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id, language)
);

CREATE INDEX IF NOT EXISTS idx_can_language_candidate ON can_language(candidate_id);

-- ---------------------------------------------------------------------------
-- can_document — document_type references System → Document Types (EMD)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_document (
  document_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  document_type VARCHAR(100) NOT NULL,
  file_name VARCHAR(500),
  storage_path TEXT,
  version NUMERIC(5, 1) NOT NULL DEFAULT 1.0,
  uploaded_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_flag BOOLEAN NOT NULL DEFAULT FALSE,
  active_flag BOOLEAN NOT NULL DEFAULT TRUE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_can_document_candidate ON can_document(candidate_id);
CREATE INDEX IF NOT EXISTS idx_can_document_type ON can_document(document_type);

-- ---------------------------------------------------------------------------
-- can_social_profile
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_social_profile (
  social_profile_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  linkedin_url TEXT,
  github_url TEXT,
  portfolio_url TEXT,
  website TEXT,
  active_flag BOOLEAN NOT NULL DEFAULT TRUE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_can_social_profile_candidate ON can_social_profile(candidate_id);

-- ---------------------------------------------------------------------------
-- can_preference — EMD-backed preference codes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_preference (
  preference_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  preferred_location VARCHAR(255),
  preferred_country VARCHAR(100),
  expected_ctc NUMERIC(14, 2),
  currency_code VARCHAR(20),
  preferred_work_mode VARCHAR(50),
  preferred_employment_type VARCHAR(100),
  travel_percentage NUMERIC(5, 2),
  active_flag BOOLEAN NOT NULL DEFAULT TRUE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_can_preference_candidate ON can_preference(candidate_id);

-- ---------------------------------------------------------------------------
-- can_notes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_notes (
  note_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  note_type VARCHAR(50) NOT NULL DEFAULT 'General',
  note TEXT NOT NULL,
  created_by VARCHAR(100),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_flag BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_can_notes_candidate ON can_notes(candidate_id);

-- ---------------------------------------------------------------------------
-- can_activity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS can_activity (
  activity_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE CASCADE,
  activity_type VARCHAR(100) NOT NULL,
  activity_description TEXT,
  activity_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  performed_by VARCHAR(100),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_can_activity_candidate ON can_activity(candidate_id);
CREATE INDEX IF NOT EXISTS idx_can_activity_date ON can_activity(activity_date DESC);

COMMIT;
