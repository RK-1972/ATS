/**
 * Filters generic web search hits; keeps evidence-backed candidate profiles/resumes only.
 */

const WEB_SEARCH_PROVIDERS = new Set([
  "serper_web_search",
  "brave_search",
  "bing_web_search"
]);

const SOURCE_SURFACE = Object.freeze({
  PUBLIC_RESUME: "public_resume",
  PROFESSIONAL_PROFILE: "professional_profile",
  DEVELOPER_PROFILE: "developer_profile",
  PORTFOLIO: "portfolio",
  REJECTED: "rejected"
});

const RESUME_AVAILABILITY = Object.freeze({
  RESUME_AVAILABLE: "resume_available",
  PROFILE_ONLY: "profile_only",
  RETRIEVAL_UNAVAILABLE: "retrieval_unavailable"
});

const REJECT_TITLE_SNIPPET =
  /\b(job details|we(?:'re| are) hiring|now hiring|open positions?|careers?\b|certificate program|training program|training-program|tutorial|online course|enroll today|learn skills essential|job description|apply now|vacancy|internship posting)\b/i;

const REJECT_PATH =
  /\/(jobs?|careers?|job-detail|jobdetails|vacancies|postings|programs|certificate-programs|training-programs|courses|tutorials|wiki)\b/i;

const REJECT_HOST =
  /(^|\.)((careers?|jobs?)\.|indeed\.|glassdoor\.|monster\.|foundit\.|naukri\.|shine\.|timesjobs\.|instahyre\.|ziprecruiter\.|greenhouse\.io|lever\.co|myworkdayjobs\.|hcltech\.com|stackoverflow\.com|wikipedia\.org|medium\.com|coursera\.org|udemy\.com|edx\.org)/i;

function extractSkillsFromEvidence(text, requiredTokens) {
  const haystack = String(text || "").toLowerCase();
  const matched = [];

  for (const token of requiredTokens || []) {
    const normalized = String(token || "").trim().toLowerCase();
    if (!normalized) {
      continue;
    }

    if (haystack.includes(normalized)) {
      matched.push(String(token).trim());
    }
  }

  return matched;
}

function slugToDisplayName(slug) {
  const value = String(slug || "")
    .trim()
    .replace(/[^\w-]+/g, "")
    .replace(/-/g, " ")
    .trim();

  if (!value || value.length < 2) {
    return null;
  }

  return value
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function parseLinkedInTitle(title) {
  const cleaned = String(title || "")
    .replace(/\s*\|\s*LinkedIn\s*$/i, "")
    .trim();

  if (!cleaned) {
    return { display_name: null, current_role: null };
  }

  const parts = cleaned.split(/\s[-–|]\s/);
  return {
    display_name: parts[0]?.trim() || null,
    current_role: parts[1]?.trim() || null
  };
}

function classifyUrl(profileUrl) {
  let parsed;

  try {
    parsed = new URL(String(profileUrl || "").trim());
  } catch {
    return { kind: SOURCE_SURFACE.REJECTED, reason: "invalid_profile_url" };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const full = `${host}${path}`;

  if (REJECT_HOST.test(host) || REJECT_PATH.test(path)) {
    return { kind: SOURCE_SURFACE.REJECTED, reason: "job_board_or_non_profile_host" };
  }

  if (/\.(pdf|doc|docx)($|\?)/i.test(parsed.pathname)) {
    if (parsed.protocol !== "https:") {
      return { kind: SOURCE_SURFACE.REJECTED, reason: "non_https_resume_url" };
    }

    return {
      kind: SOURCE_SURFACE.PUBLIC_RESUME,
      reason: null,
      resume_availability: RESUME_AVAILABILITY.RESUME_AVAILABLE
    };
  }

  const linkedInMatch = path.match(/^\/in\/([^/?#]+)/i);
  if (host.includes("linkedin.com") && linkedInMatch) {
    return {
      kind: SOURCE_SURFACE.PROFESSIONAL_PROFILE,
      reason: null,
      resume_availability: RESUME_AVAILABILITY.PROFILE_ONLY,
      linkedin_slug: linkedInMatch[1]
    };
  }

  if (host === "github.com" || host === "www.github.com") {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 1 && !["features", "topics", "marketplace", "explore"].includes(segments[0])) {
      return {
        kind: SOURCE_SURFACE.DEVELOPER_PROFILE,
        reason: null,
        resume_availability: RESUME_AVAILABILITY.PROFILE_ONLY,
        github_login: segments[0]
      };
    }

    return { kind: SOURCE_SURFACE.REJECTED, reason: "github_non_user_resource" };
  }

  if (/(portfolio|about|profile|resume|cv)/i.test(path) && !REJECT_PATH.test(path)) {
    return {
      kind: SOURCE_SURFACE.PORTFOLIO,
      reason: null,
      resume_availability: RESUME_AVAILABILITY.PROFILE_ONLY
    };
  }

  if (host.includes(".edu") || host.includes("training") || full.includes("certificate")) {
    return { kind: SOURCE_SURFACE.REJECTED, reason: "education_or_training_content" };
  }

  return { kind: SOURCE_SURFACE.REJECTED, reason: "not_a_recognized_candidate_profile" };
}

function evaluateExternalSearchHit(rawProfile, { structuredQuery } = {}) {
  const providerKey = String(rawProfile?.provider_key || "").trim();
  const profileUrl = rawProfile?.profile_url || null;
  const title = rawProfile?.display_name || rawProfile?.raw?.title || rawProfile?.raw?.name || "";
  const snippet = rawProfile?.headline || rawProfile?.raw?.snippet || rawProfile?.raw?.description || "";
  const evidenceText = `${title} ${snippet}`;
  const requiredTokens = structuredQuery?.skill_tokens || [];

  const urlClass = classifyUrl(profileUrl);

  if (REJECT_TITLE_SNIPPET.test(evidenceText)) {
    return {
      accept: false,
      source_surface_type: SOURCE_SURFACE.REJECTED,
      rejection_reason: "title_or_snippet_indicates_job_or_training_content",
      profile_url: profileUrl
    };
  }

  if (urlClass.kind === SOURCE_SURFACE.REJECTED) {
    return {
      accept: false,
      source_surface_type: SOURCE_SURFACE.REJECTED,
      rejection_reason: urlClass.reason || "not_a_candidate_profile",
      profile_url: profileUrl
    };
  }

  if (urlClass.kind !== SOURCE_SURFACE.PUBLIC_RESUME) {
    const isProfileReference =
      urlClass.kind === SOURCE_SURFACE.PROFESSIONAL_PROFILE ||
      urlClass.kind === SOURCE_SURFACE.DEVELOPER_PROFILE ||
      urlClass.kind === SOURCE_SURFACE.PORTFOLIO;

    return {
      accept: false,
      source_surface_type: urlClass.kind,
      rejection_reason: isProfileReference
        ? "profile_reference_not_resume"
        : urlClass.reason || "not_a_public_resume_document",
      profile_url: profileUrl,
      discovery_reference: isProfileReference
    };
  }

  const enriched = {
    ...rawProfile,
    skills: [],
    resume_retrieval_permitted: false,
    source_surface_type: SOURCE_SURFACE.PUBLIC_RESUME,
    resume_availability: RESUME_AVAILABILITY.RESUME_AVAILABLE,
    candidate_evidence: ["public_resume_document_url"],
    display_name: null,
    headline: title || snippet || null
  };

  return {
    accept: true,
    source_surface_type: SOURCE_SURFACE.PUBLIC_RESUME,
    resume_availability: enriched.resume_availability,
    rejection_reason: null,
    candidate_evidence: enriched.candidate_evidence,
    profile: enriched
  };
}

function filterCandidateProfiles(rawProfiles, options = {}) {
  const filtered = filterResumeDocumentCandidates(rawProfiles, options);
  return { accepted: filtered.resumeCandidates, rejected: filtered.rejected };
}

function filterResumeDocumentCandidates(rawProfiles, options = {}) {
  const resumeCandidates = [];
  const profileReferences = [];
  const rejected = [];

  for (const rawProfile of rawProfiles || []) {
    const verdict = evaluateExternalSearchHit(rawProfile, options);

    if (verdict.accept) {
      resumeCandidates.push(verdict.profile);
      continue;
    }

    if (verdict.discovery_reference) {
      profileReferences.push({
        provider_key: rawProfile?.provider_key || null,
        profile_url: verdict.profile_url || rawProfile?.profile_url || null,
        source_surface_type: verdict.source_surface_type,
        rejection_reason: verdict.rejection_reason
      });
      continue;
    }

    rejected.push({
      provider_key: rawProfile?.provider_key || null,
      profile_url: verdict.profile_url || rawProfile?.profile_url || null,
      rejection_reason: verdict.rejection_reason || "rejected",
      source_surface_type: verdict.source_surface_type || SOURCE_SURFACE.REJECTED
    });
  }

  return { resumeCandidates, profileReferences, rejected };
}

module.exports = {
  SOURCE_SURFACE,
  RESUME_AVAILABILITY,
  WEB_SEARCH_PROVIDERS,
  extractSkillsFromEvidence,
  evaluateExternalSearchHit,
  filterCandidateProfiles,
  filterResumeDocumentCandidates,
  classifyUrl,
  parseLinkedInTitle
};
