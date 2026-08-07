-- Extend om_offers with commercial offer fields for Raise Offer Request lifecycle.

ALTER TABLE om_offers
  ADD COLUMN IF NOT EXISTS expected_joining_date DATE,
  ADD COLUMN IF NOT EXISTS variable_pay NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS variable_pay_frequency VARCHAR(50),
  ADD COLUMN IF NOT EXISTS joining_bonus NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS joining_bonus_frequency VARCHAR(50);
