/**
 * Generate embeddings for indexed internal/external resume content (authorized sources only).
 */

const { buildCompositeEmbeddingText, buildContentHash } = require("./otiEmbeddingContentService");
const otiEmbeddingService = require("./otiEmbeddingService");

async function embedInternalCandidateFromIndex(pool, candidateId, deps = {}) {
  const result = await pool.query(
    `SELECT candidate_id, search_text, extracted_skills, experience_highlights
     FROM oti_resume_index
     WHERE candidate_id = $1
       AND extraction_status = 'indexed'
     LIMIT 1`,
    [candidateId]
  );

  const row = result.rows[0];
  if (!row) {
    return { skipped: true, reason: "not_indexed" };
  }

  const text = buildCompositeEmbeddingText({
    resumeText: row.search_text,
    skills: row.extracted_skills,
    experienceHighlights: row.experience_highlights
  });

  if (!text) {
    return { skipped: true, reason: "empty_content" };
  }

  return otiEmbeddingService.upsertEntityEmbedding(
    pool,
    {
      entity_type: "internal_candidate",
      entity_id: candidateId,
      source_kind: "composite",
      content_hash: buildContentHash(text)
    },
    text,
    deps
  );
}

async function embedExternalLeadFromIndex(pool, externalLeadId, deps = {}) {
  const lead = await pool.query(
    `SELECT external_lead_id, skills, experience_indicators
     FROM oti_external_lead
     WHERE external_lead_id = $1
     LIMIT 1`,
    [externalLeadId]
  );

  const index = await pool.query(
    `SELECT search_text, extracted_skills
     FROM oti_external_resume_index
     WHERE external_lead_id = $1
       AND extraction_status = 'indexed'
     LIMIT 1`,
    [externalLeadId]
  );

  const row = index.rows[0];
  if (!row) {
    return { skipped: true, reason: "not_indexed" };
  }

  const text = buildCompositeEmbeddingText({
    resumeText: row.search_text,
    skills: row.skills || row.extracted_skills,
    experienceHighlights: lead.rows[0]?.experience_indicators
  });

  if (!text) {
    return { skipped: true, reason: "empty_content" };
  }

  return otiEmbeddingService.upsertEntityEmbedding(
    pool,
    {
      entity_type: "external_lead",
      entity_id: externalLeadId,
      source_kind: "composite",
      content_hash: buildContentHash(text)
    },
    text,
    deps
  );
}

module.exports = {
  embedInternalCandidateFromIndex,
  embedExternalLeadFromIndex
};
