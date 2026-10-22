const generatedDocumentRepository = require("../repositories/generatedDocumentRepository");
const {
  GENERATED_LETTER_STATUS
} = require("../repositories/offerLetterRepository");

const AWAITING_LETTER_STATUS = "Awaiting Letter";
const OFFER_BUSINESS_OBJECT_TYPE = "OFFER";

/**
 * Letter row lacks engine-backed compensation metadata (UAT reset / migration 063 scope).
 */
function isIncompleteCompensationMetadata(letterRow) {
  if (!letterRow) {
    return true;
  }

  return (
    !letterRow.compensation_snapshot ||
    letterRow.compensation_annual_ctc == null ||
    !letterRow.compensation_structure_id
  );
}

/**
 * SQL predicate for JOIN/WHERE on om_offer_letters alias `l`.
 */
const INCOMPLETE_COMPENSATION_METADATA_SQL = `
  (
    l.compensation_snapshot IS NULL
    OR l.compensation_annual_ctc IS NULL
    OR l.compensation_structure_id IS NULL
  )
`;

/**
 * Disposable UAT reset: clear stale breakups, supersede offer documents, and
 * revert generated letter workflow so PDF/download cannot treat stale annexures as current.
 * Does not delete offers, candidates, approvals, or om_offer_letters rows.
 */
async function runUatCompensationReset(queryable) {
  const deletedCtc = await queryable.query(
    `DELETE FROM om_offer_letter_ctc c
     USING om_offer_letters l
     WHERE c.letter_id = l.letter_id
       AND ${INCOMPLETE_COMPENSATION_METADATA_SQL}`
  );

  const supersededDocs = await queryable.query(
    `UPDATE om_generated_documents gd
     SET status = $3,
         modified_on = NOW()
     WHERE gd.business_object_type = $1
       AND gd.status = $2
       AND EXISTS (
         SELECT 1
         FROM om_offer_letters l
         WHERE l.offer_id = gd.business_object_id
           AND ${INCOMPLETE_COMPENSATION_METADATA_SQL}
       )
     RETURNING gd.document_id`,
    [
      OFFER_BUSINESS_OBJECT_TYPE,
      generatedDocumentRepository.DOCUMENT_STATUSES.GENERATED,
      generatedDocumentRepository.DOCUMENT_STATUSES.SUPERSEDED
    ]
  );

  const invalidatedLetters = await queryable.query(
    `UPDATE om_offer_letters
     SET status = $1,
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
       AND status = $2
     RETURNING letter_id, offer_id`,
    [AWAITING_LETTER_STATUS, GENERATED_LETTER_STATUS]
  );

  const resetMetadata = await queryable.query(
    `UPDATE om_offer_letters
     SET compensation_calculated_on = NULL,
         compensation_calculated_by = NULL,
         compensation_structure_id = NULL,
         compensation_annual_ctc = NULL,
         compensation_locked = FALSE,
         compensation_snapshot = NULL,
         modified_on = NOW()
     WHERE compensation_snapshot IS NULL
        OR compensation_annual_ctc IS NULL
        OR compensation_structure_id IS NULL`
  );

  return {
    deletedCtcRows: deletedCtc.rowCount,
    supersededDocumentRows: supersededDocs.rowCount,
    invalidatedGeneratedLetterRows: invalidatedLetters.rowCount,
    resetLetterMetadataRows: resetMetadata.rowCount
  };
}

module.exports = {
  AWAITING_LETTER_STATUS,
  INCOMPLETE_COMPENSATION_METADATA_SQL,
  isIncompleteCompensationMetadata,
  runUatCompensationReset
};
