/**
 * Report Builder — backend-only dataset SQL definitions.
 * Joins and FROM clauses are controlled here; never exposed to clients.
 */

const RECRUITER_LATERAL_JOIN = `
LEFT JOIN LATERAL (
  SELECT ra_inner.recruiter_code
  FROM rm_recruiter_assignments ra_inner
  WHERE ra_inner.requisition_code = r.requisition_code
    AND ra_inner.is_active = TRUE
  ORDER BY ra_inner.assigned_on ASC NULLS LAST, ra_inner.assignment_id ASC
  LIMIT 1
) ra ON TRUE
LEFT JOIN user_mstr u ON u.employee_code = ra.recruiter_code`;

const DATASET_DEFINITIONS = Object.freeze({
  CANDIDATE_PIPELINE: {
    code: "CANDIDATE_PIPELINE",
    base_view_key: "candidate_pipeline_v1",
    grain: "mapping",
    grain_expression: "m.mapping_id",
    from_sql: `
FROM rm_candidate_mappings m
INNER JOIN cand_mstr c
  ON c.candidate_id = m.candidate_id
INNER JOIN rm_requisitions r
  ON r.requisition_code = m.requisition_code
${RECRUITER_LATERAL_JOIN}`,
    base_where_sql: "m.is_active = TRUE"
  },
  REQUISITION_SUMMARY: {
    code: "REQUISITION_SUMMARY",
    base_view_key: "requisition_summary_v1",
    grain: "requisition",
    grain_expression: "r.requisition_code",
    from_sql: `
FROM rm_requisitions r
LEFT JOIN wp_approved_positions p
  ON p.position_id = r.approved_position_id
${RECRUITER_LATERAL_JOIN}`,
    base_where_sql: "TRUE"
  }
});

function getDatasetDefinition(datasetCode) {
  return DATASET_DEFINITIONS[datasetCode] || null;
}

function isSupportedDatasetCode(datasetCode) {
  return Object.prototype.hasOwnProperty.call(DATASET_DEFINITIONS, datasetCode);
}

module.exports = {
  DATASET_DEFINITIONS,
  getDatasetDefinition,
  isSupportedDatasetCode
};
