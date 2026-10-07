-- Batch 1: unique PAN among REGISTERED candidates (non-null PAN only).

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cand_mstr_registered_pan_upper
  ON cand_mstr (UPPER(TRIM(pan_number)))
  WHERE UPPER(TRIM(candidate_status)) = 'REGISTERED'
    AND pan_number IS NOT NULL
    AND TRIM(pan_number) <> '';

COMMIT;
