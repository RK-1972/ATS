/**
 * OTI ranking weights — Phase 5 semantic hybrid (configurable via env overrides).
 *
 * Rationale (sum = 1.0):
 * - structured_skill: transparent Resume Match V1 overlap remains primary signal
 * - fts_relevance: lexical resume/JD keyword evidence (Phase 2)
 * - resume_extracted_skills: explicit skill mentions in indexed text (avoid duplicating structured exact matches in semantic layer)
 * - experience_alignment: tenure fit
 * - semantic_similarity: meaning-level similarity (Phase 5) — not a hiring probability
 */

function readWeight(name, fallback) {
  const envKey = `OTI_WEIGHT_${String(name).toUpperCase()}`;
  const value = Number(process.env[envKey]);

  if (Number.isFinite(value) && value >= 0) {
    return value;
  }

  return fallback;
}

function getPhase5HybridWeights() {
  return Object.freeze({
    structured_skill: readWeight("structured_skill", 0.4),
    fts_relevance: readWeight("fts_relevance", 0.2),
    resume_extracted_skills: readWeight("resume_extracted_skills", 0.12),
    experience_alignment: readWeight("experience_alignment", 0.08),
    semantic_similarity: readWeight("semantic_similarity", 0.2)
  });
}

function getPhase2HybridWeights() {
  return Object.freeze({
    structured_skill: 0.5,
    fts_relevance: 0.25,
    resume_extracted_skills: 0.15,
    experience_alignment: 0.1,
    semantic_similarity: 0
  });
}

module.exports = {
  getPhase5HybridWeights,
  getPhase2HybridWeights
};
