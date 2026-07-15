-- Enterprise intake queue table.

CREATE TABLE IF NOT EXISTS rm_candidate_intake (
  intake_id SERIAL PRIMARY KEY,
  source_id VARCHAR(120) NOT NULL REFERENCES md_candidate_sources(id),
  source_reference VARCHAR(100),
  original_file_name VARCHAR(255),
  resume_path TEXT,
  intake_status VARCHAR(30) DEFAULT 'UPLOADED',
  parsing_status VARCHAR(30) DEFAULT 'PENDING',
  duplicate_status VARCHAR(30) DEFAULT 'PENDING',
  review_status VARCHAR(30) DEFAULT 'PENDING',
  created_draft_id INTEGER,
  error_message TEXT,
  created_on TIMESTAMP DEFAULT NOW()
);
