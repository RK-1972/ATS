/**
 * OTI Phase 6 — talent adjacency classification with evidence (no verified inference).
 */

const ADJACENCY_TYPES = Object.freeze({
  DIRECT_MATCH: "direct_skill_match",
  EQUIVALENT: "equivalent_skill",
  TRANSFERABLE: "transferable_skill",
  ADJACENT_EXPERIENCE: "adjacent_experience",
  UNVERIFIED_INFERRED: "unverified_inferred_capability"
});

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function buildRequirementIndex(jdProfile) {
  const index = {
    mandatory: new Set((jdProfile?.mandatory_skills || []).map(normalizeToken)),
    preferred: new Set((jdProfile?.preferred_skills || []).map(normalizeToken)),
    equivalent: new Set((jdProfile?.equivalent_skills || []).map(normalizeToken)),
    transferable: new Set((jdProfile?.transferable_skills || []).map(normalizeToken)),
    related: new Set((jdProfile?.related_skills || []).map(normalizeToken)),
    concepts: new Set((jdProfile?.role_search_concepts || []).map(normalizeToken))
  };

  return index;
}

function classifySkillMatch(skillName, reqIndex) {
  const token = normalizeToken(skillName);

  if (!token) {
    return null;
  }

  if (reqIndex.mandatory.has(token)) {
    return {
      adjacency_type: ADJACENCY_TYPES.DIRECT_MATCH,
      verified: true,
      evidence: "Exact match to mandatory JD skill."
    };
  }

  if (reqIndex.preferred.has(token)) {
    return {
      adjacency_type: ADJACENCY_TYPES.DIRECT_MATCH,
      verified: true,
      evidence: "Exact match to preferred JD skill."
    };
  }

  if (reqIndex.equivalent.has(token)) {
    return {
      adjacency_type: ADJACENCY_TYPES.EQUIVALENT,
      verified: true,
      evidence: "Listed as equivalent in JD intelligence profile."
    };
  }

  if (reqIndex.transferable.has(token)) {
    return {
      adjacency_type: ADJACENCY_TYPES.TRANSFERABLE,
      verified: false,
      evidence: "Transferable skill association from JD intelligence (not an exact requirement)."
    };
  }

  if (reqIndex.related.has(token)) {
    return {
      adjacency_type: ADJACENCY_TYPES.ADJACENT_EXPERIENCE,
      verified: false,
      evidence: "Semantically related skill from JD intelligence profile."
    };
  }

  for (const concept of reqIndex.concepts) {
    if (token.includes(concept) || concept.includes(token)) {
      return {
        adjacency_type: ADJACENCY_TYPES.ADJACENT_EXPERIENCE,
        verified: false,
        evidence: `Role concept overlap (${concept}).`
      };
    }
  }

  return null;
}

function inferUnverifiedFromSemantic(explanation) {
  const semantic = Number(explanation?.semantic_similarity || 0);
  if (semantic < 0.45) {
    return [];
  }

  return (explanation?.semantically_related_skills || []).map((skill) => ({
    skill_name: skill.name || skill.code,
    adjacency_type: ADJACENCY_TYPES.UNVERIFIED_INFERRED,
    verified: false,
    evidence:
      "Inferred from semantic similarity to JD language; not verified as a candidate qualification.",
    disclaimer: "Do not treat inferred capability as confirmed skill proficiency."
  }));
}

function enrichCandidateAdjacency(row, jdProfile) {
  const reqIndex = buildRequirementIndex(jdProfile);
  const findings = [];

  for (const skill of row.matched_skills || []) {
    const classified = classifySkillMatch(skill.name || skill.code, reqIndex);
    if (classified) {
      findings.push({
        skill_name: skill.name || skill.code,
        ...classified
      });
    }
  }

  for (const skill of row.explanation?.resume_extracted_skills || []) {
    const classified = classifySkillMatch(skill.name || skill.code, reqIndex);
    if (
      classified &&
      !findings.some(
        (entry) => normalizeToken(entry.skill_name) === normalizeToken(skill.name || skill.code)
      )
    ) {
      findings.push({
        skill_name: skill.name || skill.code,
        ...classified,
        evidence: `${classified.evidence} (resume index evidence).`
      });
    }
  }

  for (const inferred of inferUnverifiedFromSemantic(row.explanation || {})) {
    if (
      !findings.some(
        (entry) => normalizeToken(entry.skill_name) === normalizeToken(inferred.skill_name)
      )
    ) {
      findings.push(inferred);
    }
  }

  const directCount = findings.filter(
    (entry) => entry.adjacency_type === ADJACENCY_TYPES.DIRECT_MATCH
  ).length;
  const adjacentCount = findings.filter((entry) => !entry.verified).length;

  return {
    ...row,
    explanation: {
      ...(row.explanation || {}),
      talent_adjacency: {
        schema_version: "oti_talent_adjacency_v1",
        direct_match_count: directCount,
        adjacent_match_count: adjacentCount,
        findings,
        disclaimer:
          "Unverified or inferred adjacency findings are exploratory signals only; recruiters must validate qualifications."
      }
    }
  };
}

function enrichRankedResults(rankedResults, jdProfile) {
  if (!jdProfile) {
    return rankedResults;
  }

  return (rankedResults || []).map((row) => enrichCandidateAdjacency(row, jdProfile));
}

module.exports = {
  ADJACENCY_TYPES,
  enrichRankedResults,
  enrichCandidateAdjacency,
  classifySkillMatch
};
