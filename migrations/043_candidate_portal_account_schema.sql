-- OPTALYNX Candidate Portal — Phase 1 account table
-- Links external candidate login identity to existing cand_mstr (no duplicate profile master).
-- Run: node scripts/apply043CandidatePortalMigration.js

BEGIN;

CREATE TABLE IF NOT EXISTS candidate_portal_account (
  portal_account_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL REFERENCES cand_mstr(candidate_id) ON DELETE RESTRICT,
  email_id VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  mobile_number VARCHAR(30) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_on TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_portal_account_email_lower
  ON candidate_portal_account (LOWER(email_id));

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_portal_account_candidate_id
  ON candidate_portal_account (candidate_id);

CREATE INDEX IF NOT EXISTS idx_candidate_portal_account_active
  ON candidate_portal_account (is_active);

COMMIT;
