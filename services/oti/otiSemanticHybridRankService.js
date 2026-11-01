/**
 * Phase 5 hybrid ranking — Phase 2 signals + semantic similarity.
 */

const otiHybridRankService = require("./otiHybridRankService");
const { getPhase5HybridWeights } = require("./otiRankingWeights");
const { normalizeSimilarity } = require("./otiVectorMath");

function mergeSemanticCandidates(structuredList, retrievalList, semanticList) {
  const merged = otiHybridRankService.mergeDiscoveredCandidates(structuredList, retrievalList);
  const map = new Map(merged.map((row) => [row.candidate_id, row]));

  for (const entry of semanticList || []) {
    const existing = map.get(entry.candidate_id);

    if (!existing) {
      map.set(entry.candidate_id, { ...entry });
      continue;
    }

    map.set(entry.candidate_id, {
      ...existing,
      semantic_similarity: Math.max(
        Number(existing.semantic_similarity || 0),
        Number(entry.semantic_similarity || 0)
      ),
      index_metadata: {
        ...(existing.index_metadata || {}),
        ...(entry.index_metadata || {})
      },
      source_type:
        existing.source_type === entry.source_type
          ? existing.source_type
          : `${existing.source_type}+${entry.source_type}`
    });
  }

  return Array.from(map.values());
}

function deriveSemanticSkillHints(requiredSkills, semanticScore) {
  if (semanticScore <= 0.35) {
    return [];
  }

  return (requiredSkills || []).slice(0, 2).map((skill) => ({
    code: skill.code,
    name: skill.name,
    relation: "semantically_related",
    note: "Related by embedding similarity, not an exact skill match."
  }));
}

async function rankInternalCandidatesSemanticHybrid(
  pool,
  requisition,
  structuredCandidates,
  retrievalCandidates,
  semanticCandidates,
  { queryText, structuredSkillTokens, matchedSkillsByCandidate = new Map() } = {}
) {
  const weights = getPhase5HybridWeights();
  const merged = mergeSemanticCandidates(structuredCandidates, retrievalCandidates, semanticCandidates);

  const baseRank = await otiHybridRankService.rankInternalCandidatesHybrid(
    pool,
    requisition,
    structuredCandidates,
    retrievalCandidates,
    { queryText, structuredSkillTokens }
  );

  const semanticById = new Map((semanticCandidates || []).map((row) => [row.candidate_id, row]));
  const mergedById = new Map(merged.map((row) => [row.candidate_id, row]));

  const enhanced = baseRank.ranked_results.map((row) => {
    const semanticRow = semanticById.get(row.candidate_id);
    const mergedMeta = mergedById.get(row.candidate_id);
    const semanticNorm = normalizeSimilarity(
      semanticRow?.semantic_similarity || mergedMeta?.semantic_similarity || 0
    );

    const exactMatched = new Set(
      (row.matched_skills || []).map((skill) => String(skill.name || skill.code || "").toLowerCase())
    );

    const semanticSkillHints = deriveSemanticSkillHints(row.explanation?.required_skills, semanticNorm).filter(
      (skill) => !exactMatched.has(String(skill.name || "").toLowerCase())
    );

    const structuredComponent = (row.match_pct || 0) / 100;
    const ftsComponent = Number(row.explanation?.fts_relevance || 0);
    const resumeSkillComponent =
      (row.explanation?.resume_extracted_skills || []).length > 0
        ? Math.min(1, (row.explanation.resume_extracted_skills.length || 0) / Math.max(1, (row.missing_skills || []).length + (row.matched_skills || []).length))
        : 0;
    const experienceComponent = Number(row.explanation?.experience_alignment || 0);

    const rankScore =
      structuredComponent * weights.structured_skill +
      ftsComponent * weights.fts_relevance +
      resumeSkillComponent * weights.resume_extracted_skills +
      experienceComponent * weights.experience_alignment +
      semanticNorm * weights.semantic_similarity;

    const explanation = {
      ...row.explanation,
      scoring: "oti_phase5_semantic_hybrid",
      weights,
      semantic_similarity: Number(semanticNorm.toFixed(4)),
      semantically_related_skills: semanticSkillHints,
      semantic_disclaimer:
        "Semantic similarity reflects related professional meaning; it is not a suitability probability.",
      resume_content_relevance: row.explanation?.resume_content_relevance,
      evidence_sources: {
        structured_skills: Boolean(structuredComponent > 0),
        fts: Boolean(ftsComponent > 0),
        resume_extracted_skills: Boolean(resumeSkillComponent > 0),
        semantic: Boolean(semanticNorm > 0)
      }
    };

    return {
      ...row,
      rank_score: Number(rankScore.toFixed(4)),
      explanation
    };
  });

  enhanced.sort((left, right) => right.rank_score - left.rank_score);
  enhanced.forEach((row, index) => {
    row.rank_order = index + 1;
  });

  return {
    required_skills: baseRank.required_skills,
    ranked_results: enhanced,
    weights
  };
}

module.exports = {
  rankInternalCandidatesSemanticHybrid,
  mergeSemanticCandidates
};
