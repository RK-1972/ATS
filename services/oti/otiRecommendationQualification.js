/**
 * OTI — recommendation qualification (not Resume Match V1 scoring).
 */

const OTI_MIN_RECOMMENDATION_MATCH_PCT = 50;

function isQualifyingInternalRecommendation(row) {
  const matchPct = Number(row?.match_pct);
  if (!Number.isFinite(matchPct) || matchPct < OTI_MIN_RECOMMENDATION_MATCH_PCT) {
    return false;
  }

  const matched = Array.isArray(row?.matched_skills) ? row.matched_skills : [];
  return matched.length > 0;
}

function compareQualifyingRecommendations(left, right) {
  const leftPct = Number(left?.match_pct) || 0;
  const rightPct = Number(right?.match_pct) || 0;

  if (rightPct !== leftPct) {
    return rightPct - leftPct;
  }

  const leftExp = Number(left?.total_experience);
  const rightExp = Number(right?.total_experience);
  const leftHasExp = Number.isFinite(leftExp);
  const rightHasExp = Number.isFinite(rightExp);

  if (leftHasExp && rightHasExp && rightExp !== leftExp) {
    return rightExp - leftExp;
  }
  if (rightHasExp && !leftHasExp) {
    return 1;
  }
  if (leftHasExp && !rightHasExp) {
    return -1;
  }

  return String(left?.candidate_name || "").localeCompare(String(right?.candidate_name || ""));
}

function prepareQualifyingRecommendations(rows) {
  const qualifying = (rows || []).filter(isQualifyingInternalRecommendation);
  qualifying.sort(compareQualifyingRecommendations);
  qualifying.forEach((row, index) => {
    row.rank_order = index + 1;
  });
  return qualifying;
}

function qualifyingSourcingResultSqlPredicate(tableAlias = "") {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  return `${prefix}match_pct >= ${OTI_MIN_RECOMMENDATION_MATCH_PCT}
  AND jsonb_array_length(COALESCE(${prefix}matched_skills, '[]'::jsonb)) > 0`;
}

function externalLeadMatchPct(row) {
  const fromScore = Number(row?.match_score);
  if (Number.isFinite(fromScore)) {
    return fromScore <= 1 ? Math.round(fromScore * 100) : Math.round(fromScore);
  }

  const explanation = row?.match_explanation || {};
  const fromExplanation = Number(explanation.match_score);
  if (Number.isFinite(fromExplanation)) {
    return fromExplanation <= 1 ? Math.round(fromExplanation * 100) : Math.round(fromExplanation);
  }

  return 0;
}

function externalLeadMatchedSkillTokens(row) {
  const explanation = row?.match_explanation || {};
  const matched = explanation.matched_skill_tokens;
  return Array.isArray(matched) ? matched : [];
}

function isQualifyingExternalLead(row) {
  const explanation = row?.match_explanation || {};

  if (explanation.resume_qualified === false) {
    return false;
  }

  if (row?.resume_index_status && row.resume_index_status !== "indexed") {
    return false;
  }

  if (externalLeadMatchPct(row) < OTI_MIN_RECOMMENDATION_MATCH_PCT) {
    return false;
  }

  return externalLeadMatchedSkillTokens(row).length > 0;
}

function prepareQualifyingExternalLeads(rows) {
  const qualifying = (rows || []).filter(isQualifyingExternalLead);
  qualifying.sort((left, right) => {
    const scoreDelta = (Number(right.match_score) || 0) - (Number(left.match_score) || 0);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    return (left.rank_order || 0) - (right.rank_order || 0);
  });

  qualifying.forEach((row, index) => {
    row.rank_order = index + 1;
  });

  return qualifying;
}

module.exports = {
  OTI_MIN_RECOMMENDATION_MATCH_PCT,
  isQualifyingInternalRecommendation,
  isQualifyingExternalLead,
  compareQualifyingRecommendations,
  prepareQualifyingRecommendations,
  prepareQualifyingExternalLeads,
  qualifyingSourcingResultSqlPredicate,
  externalLeadMatchPct,
  externalLeadMatchedSkillTokens
};
