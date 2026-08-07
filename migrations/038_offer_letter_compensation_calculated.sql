-- OPTALYNX Offer Letter Compensation Calculation Metadata — Sprint 12.2.2
-- Run: psql -U <user> -d <database> -f migrations/038_offer_letter_compensation_calculated.sql

BEGIN;

ALTER TABLE om_offer_letters
  ADD COLUMN IF NOT EXISTS compensation_calculated_on TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS compensation_calculated_by VARCHAR(255);

COMMIT;
