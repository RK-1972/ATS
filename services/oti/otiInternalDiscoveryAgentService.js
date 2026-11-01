/**
 * OTI Agent 2 — internal candidate discovery (talent pool + historical on target req).
 */

const candidateAccessService = require("../candidateAccessService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function listTalentPoolCandidateIds(pool, requisitionCode) {
  const result = await pool.query(
    `SELECT cm.candidate_id
     FROM cand_mstr cm
     WHERE UPPER(COALESCE(cm.candidate_container, 'PIPELINE')) = 'TALENT_POOL'
       AND COALESCE(cm.active_flag, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM rm_candidate_mappings m
         WHERE m.candidate_id = cm.candidate_id
           AND m.requisition_code = $1
           AND m.is_active = TRUE
       )`,
    [requisitionCode]
  );

  return result.rows.map((row) => ({
    candidate_id: row.candidate_id,
    source_type: "talent_pool"
  }));
}

function activeMappingOnTargetExclusionSql(requisitionParamIndex) {
  return `
       AND NOT EXISTS (
         SELECT 1
         FROM rm_candidate_mappings active_map
         WHERE active_map.candidate_id = m.candidate_id
           AND active_map.requisition_code = $${requisitionParamIndex}
           AND active_map.is_active = TRUE
       )`;
}

async function listHistoricalCandidateIds(pool, requisitionCode) {
  const result = await pool.query(
    `SELECT DISTINCT m.candidate_id
     FROM rm_candidate_mappings m
     INNER JOIN cand_mstr cm ON cm.candidate_id = m.candidate_id
     WHERE m.requisition_code = $1
       AND m.is_active = FALSE
       AND m.candidate_id IS NOT NULL
       ${activeMappingOnTargetExclusionSql(1)}`,
    [requisitionCode]
  );

  return result.rows.map((row) => ({
    candidate_id: row.candidate_id,
    source_type: "historical"
  }));
}

/**
 * Inactive mappings on other requisitions. Visibility is enforced only via
 * candidateAccessService — no requisition-level bypass for pipeline candidates.
 */
async function listHistoricalOtherRequisitionCandidateIds(pool, requisitionCode) {
  const result = await pool.query(
    `SELECT DISTINCT m.candidate_id
     FROM rm_candidate_mappings m
     INNER JOIN cand_mstr cm ON cm.candidate_id = m.candidate_id
     WHERE m.requisition_code <> $1
       AND m.is_active = FALSE
       AND m.candidate_id IS NOT NULL
       ${activeMappingOnTargetExclusionSql(1)}`,
    [requisitionCode]
  );

  return result.rows.map((row) => ({
    candidate_id: row.candidate_id,
    source_type: "historical"
  }));
}

async function filterAuthorizedCandidates(pool, req, candidates) {
  const included = [];
  const excluded = [];

  for (const entry of candidates) {
    const accessRow = await candidateAccessService.loadCandidateAccessRow(
      pool,
      entry.candidate_id
    );

    if (!accessRow) {
      excluded.push({
        candidate_id: entry.candidate_id,
        reason: "not_found"
      });
      continue;
    }

    if (candidateAccessService.canReadCandidateRow(accessRow, req)) {
      included.push({
        candidate_id: entry.candidate_id,
        source_type: entry.source_type
      });
      continue;
    }

    const draftAllowed = await candidateAccessService.canReviewDraftCandidateRow(
      pool,
      accessRow,
      req
    );

    if (draftAllowed) {
      included.push({
        candidate_id: entry.candidate_id,
        source_type: entry.source_type
      });
      continue;
    }

    excluded.push({
      candidate_id: entry.candidate_id,
      reason: "access_denied"
    });
  }

  return { included, excluded };
}

async function discoverInternalCandidates(pool, req, requisitionCode) {
  const code = String(requisitionCode || "").trim();
  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  const talentPool = await listTalentPoolCandidateIds(pool, code);
  const historicalSameReq = await listHistoricalCandidateIds(pool, code);
  const historicalOtherReq = await listHistoricalOtherRequisitionCandidateIds(
    pool,
    code
  );

  const merged = new Map();

  for (const entry of [...talentPool, ...historicalSameReq, ...historicalOtherReq]) {
    const existing = merged.get(entry.candidate_id);
    if (!existing) {
      merged.set(entry.candidate_id, entry);
      continue;
    }

    if (existing.source_type === "talent_pool") {
      continue;
    }

    if (entry.source_type === "talent_pool") {
      merged.set(entry.candidate_id, entry);
    }
  }

  const { included, excluded } = await filterAuthorizedCandidates(
    pool,
    req,
    Array.from(merged.values())
  );

  return {
    candidates: included,
    excluded,
    limitation_notes: [
      "Historical discovery includes inactive mappings on the target requisition and on other requisitions.",
      "Cross-requisition historical rows still require candidateAccessService read permission.",
      "Pipeline candidates outside owner scope are excluded; access is not broadened for search volume."
    ]
  };
}

module.exports = {
  discoverInternalCandidates,
  listTalentPoolCandidateIds,
  listHistoricalCandidateIds,
  listHistoricalOtherRequisitionCandidateIds,
  filterAuthorizedCandidates,
  activeMappingOnTargetExclusionSql
};
