/**
 * JD intelligence profile validation (Phase 6).
 */

const SCHEMA_VERSION = "oti_jd_intelligence_v1";

function asStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }

      if (item && typeof item === "object") {
        return String(item.name || item.skill || item.label || "").trim();
      }

      return "";
    })
    .filter(Boolean);
}

function validateJdIntelligenceProfile(raw) {
  const profile = raw && typeof raw === "object" ? raw : {};

  const mandatory = asStringList(profile.mandatory_skills);
  const normalized = {
    schema_version: SCHEMA_VERSION,
    source: profile.source === "ai" ? "ai" : "deterministic",
    original_jd_excerpt: String(profile.original_jd_excerpt || "").slice(0, 4000) || null,
    normalized_job_title: String(profile.normalized_job_title || "").trim() || null,
    mandatory_skills: mandatory,
    preferred_skills: asStringList(profile.preferred_skills),
    related_skills: asStringList(profile.related_skills),
    equivalent_skills: asStringList(profile.equivalent_skills),
    transferable_skills: asStringList(profile.transferable_skills),
    technologies: asStringList(profile.technologies),
    experience_expectations: {
      min_years:
        profile.experience_expectations?.min_years ??
        profile.experience_expectations?.experience_min ??
        null,
      max_years:
        profile.experience_expectations?.max_years ??
        profile.experience_expectations?.experience_max ??
        null,
      summary: String(profile.experience_expectations?.summary || "").trim() || null
    },
    industry_domain: asStringList(profile.industry_domain),
    seniority: String(profile.seniority || "").trim() || null,
    role_search_concepts: asStringList(profile.role_search_concepts),
    exclusion_criteria: asStringList(profile.exclusion_criteria),
    confidence_notes: asStringList(profile.confidence_notes),
    interpretation_disclaimer:
      String(profile.interpretation_disclaimer || "").trim() ||
      "AI interpretation supplements the original JD; mandatory requirements are only those explicitly stated in the source requisition."
  };

  if (!normalized.normalized_job_title && mandatory.length === 0) {
    throw new Error("JD intelligence profile must include a job title or mandatory skills.");
  }

  return normalized;
}

module.exports = {
  SCHEMA_VERSION,
  validateJdIntelligenceProfile,
  asStringList
};
