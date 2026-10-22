-- OPTALYNX Compensation — UAT clean reset for engine-backed breakups (forward-only)

-- Prerequisites: apply 062_compensation_configuration_unification.sql first.

-- Isolated UAT only. Do not run on production without explicit approval.

-- psql -U <user> -d <database> -f migrations/063_compensation_uat_clean_reset.sql



BEGIN;



-- Ensure 062 columns exist (idempotent if 062 already applied).

ALTER TABLE om_offer_letters

  ADD COLUMN IF NOT EXISTS compensation_annual_ctc NUMERIC(14, 2),

  ADD COLUMN IF NOT EXISTS compensation_locked BOOLEAN NOT NULL DEFAULT FALSE,

  ADD COLUMN IF NOT EXISTS compensation_snapshot JSONB;



ALTER TABLE om_offer_letter_ctc

  ADD COLUMN IF NOT EXISTS component_code VARCHAR(50);



-- 1) Remove stale breakup lines without engine snapshot metadata.

DELETE FROM om_offer_letter_ctc c

USING om_offer_letters l

WHERE c.letter_id = l.letter_id

  AND (

    l.compensation_snapshot IS NULL

    OR l.compensation_annual_ctc IS NULL

    OR l.compensation_structure_id IS NULL

  );



-- 2) Supersede generated offer documents tied to offers with incomplete letter metadata.

UPDATE om_generated_documents gd

SET status = 'Superseded',

    modified_on = NOW()

WHERE gd.business_object_type = 'OFFER'

  AND gd.status = 'Generated'

  AND EXISTS (

    SELECT 1

    FROM om_offer_letters l

    WHERE l.offer_id = gd.business_object_id

      AND (

        l.compensation_snapshot IS NULL

        OR l.compensation_annual_ctc IS NULL

        OR l.compensation_structure_id IS NULL

      )

  );



-- 3) Revert generated letter workflow so downloads cannot treat stale PDFs as current.

UPDATE om_offer_letters

SET status = 'Awaiting Letter',

    generated_by = NULL,

    generated_on = NULL,

    pdf_path = NULL,

    generation_in_progress = FALSE,

    compensation_locked = FALSE,

    modified_on = NOW()

WHERE (

    compensation_snapshot IS NULL

    OR compensation_annual_ctc IS NULL

    OR compensation_structure_id IS NULL

  )

  AND status = 'Letter Generated';



-- 4) Clear incomplete compensation metadata on affected letters.

UPDATE om_offer_letters

SET compensation_calculated_on = NULL,

    compensation_calculated_by = NULL,

    compensation_structure_id = NULL,

    compensation_annual_ctc = NULL,

    compensation_locked = FALSE,

    compensation_snapshot = NULL,

    modified_on = NOW()

WHERE compensation_snapshot IS NULL

   OR compensation_annual_ctc IS NULL

   OR compensation_structure_id IS NULL;



COMMIT;
