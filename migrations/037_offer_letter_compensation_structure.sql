-- OPTALYNX Offer Letter Compensation Structure — Sprint 12.2.2
-- Run: psql -U <user> -d <database> -f migrations/037_offer_letter_compensation_structure.sql

BEGIN;

ALTER TABLE om_offer_letters
  ADD COLUMN IF NOT EXISTS compensation_structure_id VARCHAR(50)
    REFERENCES cm_compensation_structures(structure_id);

CREATE INDEX IF NOT EXISTS idx_om_offer_letters_comp_structure
  ON om_offer_letters(compensation_structure_id);

COMMIT;
