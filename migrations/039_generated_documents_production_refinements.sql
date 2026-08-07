-- OPTALYNX Generated Documents Production Refinements — Sprint 12.3
-- Run: psql -U <user> -d <database> -f migrations/039_generated_documents_production_refinements.sql

BEGIN;

ALTER TABLE om_offer_letters
  ADD COLUMN IF NOT EXISTS generation_in_progress BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS generation_started_on TIMESTAMPTZ;

ALTER TABLE om_generated_documents
  ADD COLUMN IF NOT EXISTS template_version VARCHAR(20),
  ADD COLUMN IF NOT EXISTS generation_duration_ms INT;

COMMIT;
