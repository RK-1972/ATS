-- OPTALYNX Compensation configuration unification — forward-only
-- Run: psql -U <user> -d <database> -f migrations/062_compensation_configuration_unification.sql

BEGIN;

ALTER TABLE om_offer_letters
  ADD COLUMN IF NOT EXISTS compensation_annual_ctc NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS compensation_locked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS compensation_snapshot JSONB;

ALTER TABLE om_offer_letter_ctc
  ADD COLUMN IF NOT EXISTS component_code VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_om_offer_letters_comp_locked
  ON om_offer_letters(compensation_locked);

-- Allow admins to edit core percentage components (values remain in DB, not code).
UPDATE cm_compensation_structure_components
SET editable = TRUE,
    modified_on = NOW()
WHERE structure_component_id IN ('SC-SK-001', 'SC-SK-002')
  AND component_id IN ('COMP-BASIC-DA', 'COMP-HRA');

COMMIT;
