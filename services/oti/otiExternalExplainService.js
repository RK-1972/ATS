/**
 * Explainable external match scoring (deterministic, no LLM).
 */

function tokenOverlap(requiredTokens, profileSkills) {
  const required = (requiredTokens || []).map((token) => String(token).trim().toLowerCase()).filter(Boolean);
  const skills = (profileSkills || []).map((token) => String(token).trim().toLowerCase()).filter(Boolean);

  if (!required.length) {
    return { score: 0, matched: [], missing: [] };
  }

  const skillSet = new Set(skills);
  const matched = [];
  const missing = [];

  for (const token of required) {
    const hit = skillSet.has(token) || skills.some((skill) => skill.includes(token) || token.includes(skill));

    if (hit) {
      matched.push(token);
    } else {
      missing.push(token);
    }
  }

  return {
    score: matched.length / required.length,
    matched,
    missing
  };
}

function buildExternalMatchExplanation({ profile, structuredQuery, requisition }) {
  const resumeQualified =
    profile.resume_qualified === true || profile.resume_index_status === "indexed";

  if (!resumeQualified) {
    return {
      scoring: "oti_external_resume_content_v1",
      resume_qualified: false,
      required_skill_tokens: structuredQuery?.skill_tokens || [],
      matched_skill_tokens: [],
      missing_skill_tokens: structuredQuery?.skill_tokens || [],
      role_relevance: 0,
      profile_completeness: 0,
      provider_key: profile.provider_key,
      source_attribution: profile.source_attribution,
      resume_retrieval_permitted: false,
      source_surface_type: profile.source_surface_type || null,
      resume_availability: profile.resume_availability || "retrieval_unavailable",
      candidate_evidence: [],
      possible_internal_duplicate: Boolean(profile.possible_internal_candidate_id),
      match_score: 0
    };
  }

  const requiredTokens = structuredQuery?.skill_tokens || [];
  const overlap = tokenOverlap(requiredTokens, profile.skills);

  const roleHint = requisition?.job_title || requisition?.position_title || null;
  const headline = String(profile.headline || "").toLowerCase();
  const roleRelevance =
    roleHint && headline.includes(String(roleHint).toLowerCase()) ? 0.2 : 0;

  const completeness = Number(profile.profile_completeness || 0) * 0.15;
  const skillScore = overlap.score * 0.65;
  const matchScore = Number(Math.min(1, skillScore + roleRelevance + completeness).toFixed(4));

  return {
    scoring: "oti_external_resume_content_v1",
    resume_qualified: true,
    required_skill_tokens: requiredTokens,
    matched_skill_tokens: overlap.matched,
    missing_skill_tokens: overlap.missing,
    role_relevance: roleRelevance,
    profile_completeness: profile.profile_completeness,
    provider_key: profile.provider_key,
    source_attribution: profile.source_attribution,
    resume_retrieval_permitted: profile.resume_retrieval_permitted,
    source_surface_type: profile.source_surface_type || null,
    resume_availability: profile.resume_availability || "retrieval_unavailable",
    candidate_evidence: Array.isArray(profile.candidate_evidence) ? profile.candidate_evidence : [],
    possible_internal_duplicate: Boolean(profile.possible_internal_candidate_id),
    match_score: matchScore
  };
}

module.exports = {
  buildExternalMatchExplanation,
  tokenOverlap
};
