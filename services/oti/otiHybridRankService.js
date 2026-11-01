/**
 * OTI Phase 2 hybrid ranking.
 *
 * Weight rationale (initial modular blend, sum = 1.0):
 * - 0.50 structured skill match (Resume Match V1 overlap) — primary transparent signal
 * - 0.25 PostgreSQL FTS relevance — resume content discovery
 * - 0.15 resume-extracted skill overlap — skills evidenced in indexed text
 * - 0.10 experience alignment — relevant_experience / total vs role needs (lightweight)
 */

const otiMatchRankAgentService = require("./otiMatchRankAgentService");

const WEIGHTS = Object.freeze({
  structured_skill: 0.5,
  fts_relevance: 0.25,
  resume_extracted_skills: 0.15,
  experience_alignment: 0.1
});

function normalizeFtsRank(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.min(1, numeric / (numeric + 0.25));
}

function computeResumeSkillOverlap(requiredSkills, extractedSkills) {
  if (!requiredSkills.length) {
    return { score: 0, matched: [] };
  }

  const extractedCodes = new Set(
    (extractedSkills || []).map((skill) => String(skill.code || skill.name || "").toLowerCase())
  );

  const matched = [];

  for (const required of requiredSkills) {
    const codeKey = String(required.code || "").toLowerCase();
    const nameKey = String(required.name || "").toLowerCase();

    if ((codeKey && extractedCodes.has(codeKey)) || (nameKey && extractedCodes.has(nameKey))) {
      matched.push(required);
    }
  }

  return {
    score: matched.length / requiredSkills.length,
    matched
  };
}

function computeExperienceScore(totalExperience) {
  const years = Number(totalExperience);
  if (!Number.isFinite(years) || years <= 0) {
    return 0;
  }

  if (years >= 8) {
    return 1;
  }

  if (years >= 3) {
    return 0.7;
  }

  return 0.4;
}

function mergeDiscoveredCandidates(structuredList, retrievalList) {
  const merged = new Map();

  for (const entry of structuredList || []) {
    merged.set(entry.candidate_id, { ...entry });
  }

  for (const entry of retrievalList || []) {
    const existing = merged.get(entry.candidate_id);

    if (!existing) {
      merged.set(entry.candidate_id, { ...entry });
      continue;
    }

    merged.set(entry.candidate_id, {
      ...existing,
      fts_rank: Math.max(Number(existing.fts_rank || 0), Number(entry.fts_rank || 0)),
      index_metadata: entry.index_metadata || existing.index_metadata,
      source_type:
        existing.source_type === entry.source_type
          ? existing.source_type
          : `${existing.source_type}+${entry.source_type}`
    });
  }

  return Array.from(merged.values());
}

async function rankInternalCandidatesHybrid(
  pool,
  requisition,
  structuredCandidates,
  retrievalCandidates,
  { queryText, structuredSkillTokens } = {}
) {
  const merged = mergeDiscoveredCandidates(structuredCandidates, retrievalCandidates);
  const baseRank = await otiMatchRankAgentService.rankInternalCandidates(
    pool,
    requisition,
    merged.map((row) => ({
      candidate_id: row.candidate_id,
      source_type: row.source_type || "talent_pool"
    })),
    { structuredSkillTokens }
  );

  const retrievalById = new Map(
    (retrievalCandidates || []).map((row) => [row.candidate_id, row])
  );
  const mergedById = new Map(merged.map((row) => [row.candidate_id, row]));

  const enhanced = baseRank.ranked_results.map((row) => {
    const retrieval = retrievalById.get(row.candidate_id);
    const mergedMeta = mergedById.get(row.candidate_id);
    const ftsNorm = normalizeFtsRank(retrieval?.fts_rank || mergedMeta?.fts_rank);

    const extractedSkills =
      retrieval?.index_metadata?.extracted_skills ||
      mergedMeta?.index_metadata?.extracted_skills ||
      [];

    const requiredSkills = row.explanation?.required_skills || baseRank.required_skills || [];
    const resumeSkillOverlap = computeResumeSkillOverlap(requiredSkills, extractedSkills);
    const experienceScore = computeExperienceScore(row.total_experience);

    const structuredComponent = (row.match_pct || 0) / 100;
    const rankScore =
      structuredComponent * WEIGHTS.structured_skill +
      ftsNorm * WEIGHTS.fts_relevance +
      resumeSkillOverlap.score * WEIGHTS.resume_extracted_skills +
      experienceScore * WEIGHTS.experience_alignment;

    const explanation = {
      ...row.explanation,
      scoring: "oti_phase2_hybrid",
      weights: WEIGHTS,
      structured_skill_pct: row.match_pct,
      fts_relevance: Number(ftsNorm.toFixed(4)),
      resume_extracted_skills: resumeSkillOverlap.matched.map((skill) => ({
        code: skill.code,
        name: skill.name
      })),
      experience_alignment: Number(experienceScore.toFixed(4)),
      resume_content_relevance:
        ftsNorm > 0
          ? "Resume text matches role keywords."
          : "No indexed resume keyword match for this query.",
      missing_or_partial: row.missing_skills || [],
      query_text: queryText || null
    };

    return {
      ...row,
      rank_score: Number(rankScore.toFixed(4)),
      match_pct: row.match_pct,
      explanation
    };
  });

  enhanced.sort((left, right) => {
    if (right.rank_score !== left.rank_score) {
      return right.rank_score - left.rank_score;
    }

    return (right.match_pct || 0) - (left.match_pct || 0);
  });

  enhanced.forEach((row, index) => {
    row.rank_order = index + 1;
  });

  return {
    required_skills: baseRank.required_skills,
    ranked_results: enhanced,
    weights: WEIGHTS
  };
}

module.exports = {
  WEIGHTS,
  rankInternalCandidatesHybrid,
  mergeDiscoveredCandidates,
  normalizeFtsRank
};
