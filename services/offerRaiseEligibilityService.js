const {
  FINAL_HR_INTERVIEW_ROUND_TYPE,
  FINAL_HR_INTERVIEW_OUTCOME_SELECTED
} = require("../constants/offerRaiseEligibility");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
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

const OFFER_RAISE_ELIGIBLE_SQL = `
  SELECT DISTINCT ON (COALESCE(m.mapping_id, m.map_id))
    m.*,
    c.candidate_code,
    CONCAT(c.first_name, ' ', c.last_name) AS candidate_name
  FROM rm_candidate_mappings m
  INNER JOIN rm_recruiter_assignments a
    ON a.requisition_code = m.requisition_code
   AND a.recruiter_code = $1
   AND a.is_active = TRUE
  INNER JOIN im_interviews i
    ON i.candidate_id = m.candidate_id
   AND i.requisition_code = m.requisition_code
   AND i.round_type = $2
   AND i.final_outcome = $3
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
  ORDER BY COALESCE(m.mapping_id, m.map_id), m.modified_on DESC NULLS LAST
`;

async function listOfferRaiseEligibleMappings(pool, employeeCode) {
  const result = await pool.query(OFFER_RAISE_ELIGIBLE_SQL, [
    employeeCode,
    FINAL_HR_INTERVIEW_ROUND_TYPE,
    FINAL_HR_INTERVIEW_OUTCOME_SELECTED
  ]);
  return result.rows;
}

async function assertMappingEligibleForOfferRaise(pool, mapping, legacyRow) {
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

  const result = await pool.query(
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
}

module.exports = {
  interviewQualifiesForOfferRaise,
  listOfferRaiseEligibleMappings,
  assertMappingEligibleForOfferRaise,
  FINAL_HR_INTERVIEW_ROUND_TYPE,
  FINAL_HR_INTERVIEW_OUTCOME_SELECTED
};
