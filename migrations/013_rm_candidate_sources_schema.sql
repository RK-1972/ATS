-- Enterprise master table for candidate intake sources.

CREATE TABLE IF NOT EXISTS rm_candidate_sources (
  source_id SERIAL PRIMARY KEY,
  source_code VARCHAR(30) UNIQUE NOT NULL,
  source_name VARCHAR(100) NOT NULL,
  ownership_strategy VARCHAR(30) NOT NULL,
  allow_resume_upload BOOLEAN DEFAULT TRUE,
  allow_bulk_upload BOOLEAN DEFAULT FALSE,
  requires_vendor BOOLEAN DEFAULT FALSE,
  requires_referral BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  display_order INTEGER DEFAULT 1,
  created_on TIMESTAMP DEFAULT NOW()
);
