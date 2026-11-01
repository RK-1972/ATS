/**
 * OTI Phase 2 — PostgreSQL full-text retrieval over indexed resumes.
 * Never returns extracted resume text; authorization enforced per candidate.
 */

const candidateAccessService = require("../candidateAccessService");
const { splitSkillTokens } = require("../resumeMatchService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function buildSearchQueryText({ queryText, requisition }) {
  const parts = [];

  for (const token of splitSkillTokens(queryText)) {
    if (token) {
      parts.push(token);
    }
  }

  for (const token of splitSkillTokens(requisition?.primary_skill)) {
    if (token) {
      parts.push(token);
    }
  }

  if (requisition?.job_title) {
    parts.push(String(requisition.job_title).trim());
  }

  if (requisition?.position_title) {
    parts.push(String(requisition.position_title).trim());
  }

  const combined = parts.join(" ").trim();
  return combined || "recruitment";
}

async function searchIndexedCandidates(pool, req, { requisitionCode, queryText, requisition, limit = 50 }) {
  const code = String(requisitionCode || "").trim();
  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  const searchQuery = buildSearchQueryText({ queryText, requisition });

  const result = await pool.query(
    `SELECT
        idx.candidate_id,
        ts_rank(idx.search_vector, websearch_to_tsquery('english', $1)) AS fts_rank,
        idx.extracted_skills,
        idx.experience_highlights,
        idx.role_highlights
     FROM oti_resume_index idx
     WHERE idx.extraction_status = 'indexed'
       AND idx.search_vector @@ websearch_to_tsquery('english', $1)
       AND NOT EXISTS (
         SELECT 1
         FROM rm_candidate_mappings m
         WHERE m.candidate_id = idx.candidate_id
           AND m.requisition_code = $2
           AND m.is_active = TRUE
       )
     ORDER BY fts_rank DESC
     LIMIT $3`,
    [searchQuery, code, limit]
  );

  const included = [];
  const excluded = [];

  for (const row of result.rows) {
    const accessRow = await candidateAccessService.loadCandidateAccessRow(
      pool,
      row.candidate_id
    );

    if (!accessRow) {
      excluded.push({ candidate_id: row.candidate_id, reason: "not_found" });
      continue;
    }

    if (!candidateAccessService.canReadCandidateRow(accessRow, req)) {
      const draftAllowed = await candidateAccessService.canReviewDraftCandidateRow(
        pool,
        accessRow,
        req
      );

      if (!draftAllowed) {
        excluded.push({ candidate_id: row.candidate_id, reason: "access_denied" });
        continue;
      }
    }

    included.push({
      candidate_id: row.candidate_id,
      source_type: "resume_index",
      fts_rank: Number(row.fts_rank || 0),
      index_metadata: {
        extracted_skills: row.extracted_skills || [],
        experience_highlights: row.experience_highlights || [],
        role_highlights: row.role_highlights || []
      }
    });
  }

  return {
    candidates: included,
    excluded,
    search_query: searchQuery
  };
}

module.exports = {
  searchIndexedCandidates,
  buildSearchQueryText
};
