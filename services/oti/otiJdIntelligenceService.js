/**
 * OTI Phase 6 — JD intelligence (deterministic baseline + optional OpenAI interpretation).
 */

const { splitSkillTokens } = require("../resumeMatchService");
const { getActiveProvider } = require("./ai/otiAiProviderRegistry");
const {
  validateJdIntelligenceProfile,
  SCHEMA_VERSION
} = require("./otiJdIntelligenceSchema");
const otiAiGovernanceService = require("./otiAiGovernanceService");

function buildJdSourceText(requisition) {
  const parts = [
    requisition?.job_title,
    requisition?.position_title,
    requisition?.primary_skill,
    requisition?.secondary_skill,
    requisition?.job_description
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return parts.join("\n\n");
}

function buildDeterministicProfile(requisition) {
  const jdText = buildJdSourceText(requisition);
  const mandatory = splitSkillTokens(requisition?.primary_skill);
  const preferred = splitSkillTokens(requisition?.secondary_skill);

  return validateJdIntelligenceProfile({
    schema_version: SCHEMA_VERSION,
    source: "deterministic",
    original_jd_excerpt: jdText.slice(0, 4000),
    normalized_job_title:
      String(requisition?.job_title || requisition?.position_title || "").trim() || null,
    mandatory_skills: mandatory,
    preferred_skills: preferred,
    related_skills: [],
    equivalent_skills: [],
    transferable_skills: [],
    technologies: mandatory.slice(0, 5),
    experience_expectations: {
      min_years: requisition?.experience_min ?? null,
      max_years: requisition?.experience_max ?? null,
      summary: null
    },
    industry_domain: [],
    seniority: null,
    role_search_concepts: mandatory.slice(0, 3),
    exclusion_criteria: [],
    confidence_notes: ["Deterministic profile derived from requisition fields only."],
    interpretation_disclaimer:
      "This profile was generated without LLM interpretation from explicit requisition fields."
  });
}

const JD_SYSTEM_PROMPT = `You are an expert technical recruiter assistant for Optalynx OTI.
Return JSON only. Do not invent mandatory skills that are not supported by the JD text.
Mark inferred items in related_skills or transferable_skills, never as mandatory_skills unless explicitly required in the JD.
Fields: normalized_job_title, mandatory_skills[], preferred_skills[], related_skills[], equivalent_skills[], transferable_skills[], technologies[], experience_expectations{min_years,max_years,summary}, industry_domain[], seniority, role_search_concepts[], exclusion_criteria[], confidence_notes[].`;

async function analyzeJdIntelligence(pool, runId, requisition, options = {}) {
  const { useAi = false, tracker, provider = getActiveProvider() } = options;
  const deterministic = buildDeterministicProfile(requisition);

  if (!useAi) {
    return {
      profile: deterministic,
      used_ai: false,
      fallback_reason: null
    };
  }

  try {
    otiAiGovernanceService.assertWithinRunLimits(tracker);
    const jdText = buildJdSourceText(requisition);

    const result = await provider.completeStructuredJson({
      systemPrompt: JD_SYSTEM_PROMPT,
      userPrompt: `Analyze this job requisition and produce a JD intelligence profile JSON object.\n\n${jdText}`,
      responseLabel: "jd_intelligence"
    });

    const merged = validateJdIntelligenceProfile({
      ...result.json,
      schema_version: SCHEMA_VERSION,
      source: "ai",
      original_jd_excerpt: jdText.slice(0, 4000),
      mandatory_skills:
        asStringListSafe(result.json?.mandatory_skills).length > 0
          ? intersectMandatoryWithSource(asStringListSafe(result.json.mandatory_skills), deterministic.mandatory_skills, jdText)
          : deterministic.mandatory_skills,
      preferred_skills:
        asStringListSafe(result.json?.preferred_skills).length > 0
          ? asStringListSafe(result.json.preferred_skills)
          : deterministic.preferred_skills,
      experience_expectations: {
        min_years:
          result.json?.experience_expectations?.min_years ?? deterministic.experience_expectations.min_years,
        max_years:
          result.json?.experience_expectations?.max_years ?? deterministic.experience_expectations.max_years,
        summary: result.json?.experience_expectations?.summary || null
      }
    });

    const cost = otiAiGovernanceService.estimateCostUsd(
      result.usage.total_tokens,
      result.model_id
    );

    await otiAiGovernanceService.recordSuccessfulAiCall(pool, runId, tracker, {
      model_provider: result.model_provider,
      model_id: result.model_id,
      request_type: "jd_intelligence",
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      total_tokens: result.usage.total_tokens,
      estimated_cost_usd: cost
    });

    return {
      profile: merged,
      used_ai: true,
      fallback_reason: null
    };
  } catch (error) {
    tracker.limitation_notes.push(
      `JD intelligence AI unavailable (${error.message}); deterministic profile used.`
    );

    return {
      profile: deterministic,
      used_ai: false,
      fallback_reason: error.message
    };
  }
}

function asStringListSafe(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function intersectMandatoryWithSource(aiMandatory, deterministicMandatory, jdText) {
  const jdLower = String(jdText || "").toLowerCase();
  const allowed = new Set(deterministicMandatory.map((item) => item.toLowerCase()));

  const filtered = aiMandatory.filter((skill) => {
    const key = skill.toLowerCase();
    if (allowed.has(key)) {
      return true;
    }

    return jdLower.includes(key);
  });

  return filtered.length ? filtered : deterministicMandatory;
}

function profileToStructuredQuery(profile, queryText, requisitionCode) {
  const tokens = [];
  const seen = new Set();

  for (const list of [
    profile.mandatory_skills,
    profile.preferred_skills,
    profile.related_skills,
    profile.technologies,
    profile.role_search_concepts
  ]) {
    for (const token of list || []) {
      const key = String(token).toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      tokens.push(String(token).trim());
    }
  }

  for (const token of splitSkillTokens(queryText)) {
    const key = token.toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    tokens.push(token);
  }

  return {
    skill_tokens: tokens,
    query_text: String(queryText || "").trim() || null,
    requisition_code: requisitionCode || null,
    jd_intelligence_version: profile.schema_version,
    normalized_job_title: profile.normalized_job_title
  };
}

module.exports = {
  buildDeterministicProfile,
  analyzeJdIntelligence,
  profileToStructuredQuery,
  buildJdSourceText
};
