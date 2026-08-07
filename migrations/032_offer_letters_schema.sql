-- OPTALYNX Offer Letters — Sprint 12.1
-- Run: psql -U <user> -d <database> -f migrations/032_offer_letters_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS om_offer_letters (
  letter_id VARCHAR(50) PRIMARY KEY,
  offer_id VARCHAR(50) NOT NULL REFERENCES om_offers(offer_id) ON DELETE CASCADE,
  template_name VARCHAR(100) NOT NULL DEFAULT 'Standard Offer Letter',
  status VARCHAR(50) NOT NULL DEFAULT 'Awaiting Letter',
  pdf_path TEXT,
  generated_by VARCHAR(255),
  generated_on TIMESTAMPTZ,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_om_offer_letters_offer
  ON om_offer_letters(offer_id);

CREATE INDEX IF NOT EXISTS idx_om_offer_letters_status
  ON om_offer_letters(status);

CREATE TABLE IF NOT EXISTS om_offer_letter_ctc (
  ctc_id SERIAL PRIMARY KEY,
  letter_id VARCHAR(50) NOT NULL REFERENCES om_offer_letters(letter_id) ON DELETE CASCADE,
  component_name VARCHAR(100) NOT NULL,
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  display_order INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_om_offer_letter_ctc_letter
  ON om_offer_letter_ctc(letter_id);

COMMIT;
