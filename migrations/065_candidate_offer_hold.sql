-- Candidate Offer Hold — cross-requisition recruiting restriction after offer release.
-- Run via standard migration process (not executed in this change).

BEGIN;

CREATE TABLE IF NOT EXISTS rm_candidate_offer_hold (
  hold_id SERIAL PRIMARY KEY,
  candidate_id INT NOT NULL,
  offer_id VARCHAR(50) NOT NULL,
  source_requisition_code VARCHAR(50),
  hold_status VARCHAR(20) NOT NULL DEFAULT 'Active',
  -- Audit snapshot of JWT employee_code at offer release (not release authority).
  activated_by_employee_code VARCHAR(100) NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_by VARCHAR(255),
  released_at TIMESTAMPTZ,
  released_by VARCHAR(255),
  release_reason TEXT,
  activation_side_effects JSONB,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rm_candidate_offer_hold_active_candidate
  ON rm_candidate_offer_hold (candidate_id)
  WHERE hold_status = 'Active';

CREATE INDEX IF NOT EXISTS idx_rm_candidate_offer_hold_offer
  ON rm_candidate_offer_hold (offer_id);

CREATE TABLE IF NOT EXISTS rm_candidate_offer_hold_event (
  event_id SERIAL PRIMARY KEY,
  hold_id INT NOT NULL REFERENCES rm_candidate_offer_hold(hold_id) ON DELETE CASCADE,
  event_type VARCHAR(80) NOT NULL,
  actor_employee_code VARCHAR(100),
  actor_name VARCHAR(255),
  actor_role VARCHAR(100),
  from_status VARCHAR(20),
  to_status VARCHAR(20),
  reason TEXT,
  metadata JSONB,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rm_candidate_offer_hold_event_hold
  ON rm_candidate_offer_hold_event (hold_id);

COMMIT;
