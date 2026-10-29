const {
  FINAL_HR_INTERVIEW_ROUND_TYPE,
  FINAL_HR_INTERVIEW_OUTCOME_SELECTED
} = require("../constants/offerRaiseEligibility");
const { GENERATED_LETTER_STATUS } = require("../repositories/offerLetterRepository");

const DUPLICATE_OFFER_MESSAGE =
  "An offer already exists for this candidate on this requisition.";

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeRequisitionCode(value) {
  return String(value || "").trim();
}

function resolveMappingCandidateId(mapping) {
  const candidateId = Number(mapping?.candidate_id);
  return Number.isFinite(candidateId) ? candidateId : null;
}

/**
 * Same candidate–requisition pair used for offer raise (Rule C).
 */
function mappingOfferScope(mapping) {
  if (!mapping) {
    return null;
  }
  const requisitionCode = normalizeRequisitionCode(mapping.requisition_code);
  const candidateId = resolveMappingCandidateId(mapping);
  if (!requisitionCode || candidateId == null) {
    return null;
  }
  const rawMappingKey = mapping.mapping_id ?? mapping.map_id;
  const mappingKey = rawMappingKey != null ? Number(rawMappingKey) : null;
  return {
    candidateId,
    requisitionCode,
    mappingKey: Number.isFinite(mappingKey) ? mappingKey : null
  };
}

/**
 * Pure rule: does this interview row qualify the mapping for offer raise?
 * Exported for unit tests.
 */
function interviewQualifiesForOfferRaise(mapping, interview) {
  if (!mapping || !interview) {
    return false;
  }

  const roundType = String(interview.round_type || "").trim();
  const outcome = String(interview.final_outcome || "").trim();
  if (roundType !== FINAL_HR_INTERVIEW_ROUND_TYPE) {
    return false;
  }
  if (outcome !== FINAL_HR_INTERVIEW_OUTCOME_SELECTED) {
    return false;
  }
  if (!interview.feedback_submitted) {
    return false;
  }

  const mappingReq = String(mapping.requisition_code || "").trim();
  const interviewReq = String(interview.requisition_code || "").trim();
  if (!mappingReq || !interviewReq || mappingReq !== interviewReq) {
    return false;
  }

  const mappingCandidateId = Number(mapping.candidate_id);
  const interviewCandidateId = Number(interview.candidate_id);
  if (
    !Number.isFinite(mappingCandidateId) ||
    !Number.isFinite(interviewCandidateId) ||
    mappingCandidateId !== interviewCandidateId
  ) {
    return false;
  }

  const iMapId = interview.map_id != null ? Number(interview.map_id) : null;
  const mMapId = mapping.map_id != null ? Number(mapping.map_id) : null;
  const mMappingId = mapping.mapping_id != null ? Number(mapping.mapping_id) : null;

  if (iMapId != null && Number.isFinite(iMapId)) {
    if (mMapId != null && iMapId === mMapId) {
      return true;
    }
    if (mMappingId != null && iMapId === mMappingId) {
      return true;
    }
    return false;
  }

  return true;
}

const OFFER_RAISE_BLOCKING_OFFER_SQL = `
  SELECT o.offer_id, o.offer_status
  FROM om_offers o
  WHERE o.candidate_id = $1
    AND (
      (
        o.requisition_code = $2
        AND TRIM(COALESCE(o.requisition_code, '')) <> ''
      )
      OR (
        $3::int IS NOT NULL
        AND o.mapping_id = $3::int
        AND TRIM(COALESCE(o.requisition_code, '')) = ''
      )
    )
  LIMIT 1
`;

const OFFER_RAISE_BLOCKING_LETTER_SQL = `
  SELECT ol.letter_id, ol.status AS letter_status, o.offer_id
  FROM om_offers o
  INNER JOIN om_offer_letters ol ON ol.offer_id = o.offer_id
  WHERE o.candidate_id = $1
    AND (
      (
        o.requisition_code = $2
        AND TRIM(COALESCE(o.requisition_code, '')) <> ''
      )
      OR (
        $3::int IS NOT NULL
        AND o.mapping_id = $3::int
        AND TRIM(COALESCE(o.requisition_code, '')) = ''
      )
    )
  LIMIT 1
`;

/**
 * Returns blocking row metadata when an offer or offer letter already exists for the mapping scope.
 */
async function findBlockingOfferActivityForMapping(queryable, mapping) {
  const scope = mappingOfferScope(mapping);
  if (!scope) {
    return null;
  }

  const offerResult = await queryable.query(OFFER_RAISE_BLOCKING_OFFER_SQL, [
    scope.candidateId,
    scope.requisitionCode,
    scope.mappingKey
  ]);
  if (offerResult.rows[0]) {
    return { kind: "offer", ...offerResult.rows[0] };
  }

  const letterResult = await queryable.query(OFFER_RAISE_BLOCKING_LETTER_SQL, [
    scope.candidateId,
    scope.requisitionCode,
    scope.mappingKey
  ]);
  if (letterResult.rows[0]) {
    return { kind: "offer_letter", ...letterResult.rows[0] };
  }

  return null;
}

async function assertNoBlockingOfferActivityForMapping(queryable, mapping) {
  const blocking = await findBlockingOfferActivityForMapping(queryable, mapping);
  if (blocking) {
    throw httpError(DUPLICATE_OFFER_MESSAGE, 400);
  }
}

/**
 * Serializes offer raise for one candidate–requisition mapping (transaction-scoped advisory lock + row lock).
 */
async function acquireOfferRaiseCreationLock(client, mappingRef, mapping) {
  const scope = mappingOfferScope(mapping);
  if (!scope || mappingRef == null || mappingRef === "") {
    throw httpError("Mapping not found.", 404);
  }

  const lockRow = await client.query(
    `SELECT mapping_id, map_id, candidate_id, requisition_code
     FROM rm_candidate_mappings
     WHERE (mapping_id = $1 OR map_id = $1)
       AND is_active = TRUE
     FOR UPDATE`,
    [mappingRef]
  );

  if (!lockRow.rows[0]) {
    throw httpError("Mapping not found.", 404);
  }

  await client.query(
    `SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))`,
    [scope.candidateId, scope.requisitionCode]
  );
}

const OFFER_RAISE_ELIGIBLE_SQL = `
  SELECT DISTINCT ON (COALESCE(m.mapping_id, m.map_id))
    m.*,
    c.candidate_code,
    CONCAT(c.first_name, ' ', c.last_name) AS candidate_name
  FROM rm_candidate_mappings m
  INNER JOIN im_interviews i
    ON i.candidate_id = m.candidate_id
   AND i.requisition_code = m.requisition_code
   AND i.round_type = $1
   AND i.final_outcome = $2
   AND i.feedback_submitted = TRUE
   AND (
     (m.map_id IS NOT NULL AND i.map_id = m.map_id)
     OR (m.mapping_id IS NOT NULL AND i.map_id = m.mapping_id)
     OR (
       i.map_id IS NULL
       AND i.candidate_id = m.candidate_id
       AND i.requisition_code = m.requisition_code
     )
   )
  LEFT JOIN cand_mstr c ON c.candidate_id = m.candidate_id
  WHERE m.is_active = TRUE
    AND NOT EXISTS (
      SELECT 1
      FROM om_offers o
      WHERE o.candidate_id = m.candidate_id
        AND (
          (
            o.requisition_code = m.requisition_code
            AND TRIM(COALESCE(o.requisition_code, '')) <> ''
          )
          OR (
            o.mapping_id IS NOT NULL
            AND o.mapping_id = COALESCE(m.mapping_id, m.map_id)
            AND TRIM(COALESCE(o.requisition_code, '')) = ''
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM om_offers o
      INNER JOIN om_offer_letters ol ON ol.offer_id = o.offer_id
      WHERE o.candidate_id = m.candidate_id
        AND (
          (
            o.requisition_code = m.requisition_code
            AND TRIM(COALESCE(o.requisition_code, '')) <> ''
          )
          OR (
            o.mapping_id IS NOT NULL
            AND o.mapping_id = COALESCE(m.mapping_id, m.map_id)
            AND TRIM(COALESCE(o.requisition_code, '')) = ''
          )
        )
    )
  ORDER BY COALESCE(m.mapping_id, m.map_id), m.modified_on DESC NULLS LAST
`;

async function listOfferRaiseEligibleMappings(pool) {
  const result = await pool.query(OFFER_RAISE_ELIGIBLE_SQL, [
    FINAL_HR_INTERVIEW_ROUND_TYPE,
    FINAL_HR_INTERVIEW_OUTCOME_SELECTED
  ]);
  return result.rows;
}

async function assertMappingEligibleForOfferRaise(queryable, mapping, legacyRow) {
  const activeMapping = mapping || legacyRow;
  if (!activeMapping) {
    throw httpError("Mapping not found.", 404);
  }

  const requisitionCode = String(activeMapping.requisition_code || "").trim();
  const candidateId = activeMapping.candidate_id;

  if (!requisitionCode || candidateId == null) {
    throw httpError(
      "Offer cannot be raised until Final HR Interview outcome is Selected for this requisition.",
      400
    );
  }

  const result = await queryable.query(
    `SELECT i.*
     FROM im_interviews i
     WHERE i.candidate_id = $1
       AND i.requisition_code = $2
       AND i.round_type = $3
       AND i.final_outcome = $4
       AND i.feedback_submitted = TRUE`,
    [
      candidateId,
      requisitionCode,
      FINAL_HR_INTERVIEW_ROUND_TYPE,
      FINAL_HR_INTERVIEW_OUTCOME_SELECTED
    ]
  );

  const qualified = result.rows.some((row) =>
    interviewQualifiesForOfferRaise(activeMapping, row)
  );

  if (!qualified) {
    throw httpError(
      "Offer cannot be raised until Final HR Interview outcome is Selected for this requisition.",
      400
    );
  }

  await assertNoBlockingOfferActivityForMapping(queryable, activeMapping);
}

module.exports = {
  interviewQualifiesForOfferRaise,
  listOfferRaiseEligibleMappings,
  assertMappingEligibleForOfferRaise,
  findBlockingOfferActivityForMapping,
  assertNoBlockingOfferActivityForMapping,
  acquireOfferRaiseCreationLock,
  mappingOfferScope,
  DUPLICATE_OFFER_MESSAGE,
  GENERATED_LETTER_STATUS,
  FINAL_HR_INTERVIEW_ROUND_TYPE,
  FINAL_HR_INTERVIEW_OUTCOME_SELECTED
};
