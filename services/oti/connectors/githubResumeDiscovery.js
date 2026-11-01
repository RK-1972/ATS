/**
 * GitHub public API queries for India-relevant developer discovery and public resume/CV files.
 */

const {
  extractIndianCityLabels,
  resolveSourcingCountry
} = require("./otiWebSearchCandidateQuery");

const RESUME_FILENAME_PATTERN = /(?:^|[/\\])(?:resume|cv|curriculum-vitae|curriculum_vitae)(?:[-_\s][\w.-]+)?\.(pdf|docx?)$/i;
const RESUME_PATH_HINT = /(?:^|[/\\])(?:resume|cv|curriculum|profile)\b/i;

function uniqueTokens(tokens) {
  const seen = new Set();
  const output = [];

  for (const token of tokens || []) {
    const value = String(token || "").trim();
    if (!value) {
      continue;
    }

    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(value);
  }

  return output;
}

function buildGitHubUserSearchQuery({ queryText, structuredQuery, requisition } = {}) {
  const role = String(
    requisition?.job_title || requisition?.position_title || queryText || ""
  ).trim();
  const skills = uniqueTokens(structuredQuery?.skill_tokens).slice(0, 4);
  const country = resolveSourcingCountry(requisition);
  const cities = extractIndianCityLabels(requisition);
  const locationTerms = [];

  if (cities.length) {
    locationTerms.push(...cities.slice(0, 2).map((city) => `location:"${city}"`));
  }

  if (/india/i.test(country)) {
    locationTerms.push('location:"India"');
  } else if (country) {
    locationTerms.push(`location:"${country.replace(/"/g, "")}"`);
  }

  const parts = uniqueTokens([role, ...skills, ...locationTerms]).filter(Boolean);

  if (!parts.length) {
    return "location:India developer in:bio,location type:user";
  }

  return `${parts.join(" ")} in:bio,location type:user`.trim();
}

function buildGitHubResumeCodeSearchQueries({ structuredQuery, queryText, requisition, userLogins = [] } = {}) {
  const skills = uniqueTokens(structuredQuery?.skill_tokens).slice(0, 3);
  const role = String(
    requisition?.job_title || requisition?.position_title || queryText || ""
  ).trim();
  const skillExpr = skills.length ? skills.join(" ") : role;
  const queries = [];

  // GitHub code search rejects nested "(filename:… OR …)" groups (HTTP 422). Use flat qualifiers.
  const resumeFileQueries = [
    "filename:resume extension:pdf",
    "filename:CV extension:pdf",
    "filename:cv extension:docx"
  ];

  if (userLogins.length) {
    for (const login of userLogins.slice(0, 6)) {
      for (const fileQuery of resumeFileQueries) {
        queries.push(`user:${login} ${fileQuery}`);
      }
    }
  }

  if (skillExpr) {
    queries.push(`${skillExpr} filename:resume extension:pdf`);
    queries.push(`${skillExpr} filename:CV extension:pdf`);
  } else {
    queries.push("filename:resume extension:pdf");
  }

  const seen = new Set();

  return queries.filter((query) => {
    const key = query.toLowerCase();
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function isPublicResumeDocumentPath(name, path) {
  const combined = `${path || ""}/${name || ""}`.trim();

  return RESUME_FILENAME_PATTERN.test(combined) || RESUME_PATH_HINT.test(combined);
}

function parseGitHubBlobRef(htmlUrl) {
  const match = String(htmlUrl || "").match(/github\.com\/[^/]+\/[^/]+\/blob\/([^/]+)\/(.+)$/i);

  if (!match) {
    return null;
  }

  return {
    ref: decodeURIComponent(match[1]),
    path: decodeURIComponent(match[2])
  };
}

function buildRawGitHubContentUrl({ htmlUrl, repository, path }) {
  const repoFullName = String(repository?.full_name || "").trim();
  const filePath = String(path || "").trim();

  if (!repoFullName || !filePath) {
    return null;
  }

  const blobRef = parseGitHubBlobRef(htmlUrl);
  const ref = blobRef?.ref || repository?.default_branch || "main";
  const [owner, repo] = repoFullName.split("/");

  if (!owner || !repo) {
    return null;
  }

  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
}

function mapGitHubUserProfile(item) {
  return {
    provider_key: "github",
    source_record_id: `user:${item.id || item.login}`,
    profile_url: item.html_url || null,
    display_name: item.login || null,
    headline: null,
    current_role: null,
    organization: null,
    location: null,
    skills: [],
    experience_indicators: [],
    discovery_kind: "github_profile_reference",
    raw: {
      login: item.login,
      id: item.id,
      html_url: item.html_url,
      type: item.type
    },
    data_access_permissions: {
      public_profile: true,
      email: false
    },
    resume_retrieval_permitted: false,
    source_attribution: {
      provider: "GitHub",
      api: "search/users",
      terms_url: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service"
    },
    discovered_on: new Date().toISOString()
  };
}

function mapGitHubResumeCodeHit(item) {
  const path = String(item?.path || item?.name || "").trim();
  const name = String(item?.name || "").trim();

  if (!isPublicResumeDocumentPath(name, path)) {
    return null;
  }

  const profileUrl = buildRawGitHubContentUrl({
    htmlUrl: item.html_url,
    repository: item.repository,
    path
  });

  if (!profileUrl) {
    return null;
  }

  const repoFullName = item.repository?.full_name || "unknown/repo";
  const ownerLogin = item.repository?.owner?.login || null;

  return {
    provider_key: "github",
    source_record_id: `code:${repoFullName}:${path}:${item.sha || ""}`,
    profile_url: profileUrl,
    display_name: null,
    headline: path,
    current_role: null,
    organization: repoFullName,
    location: ownerLogin ? `GitHub @${ownerLogin}` : null,
    skills: [],
    experience_indicators: [],
    discovery_kind: "github_public_resume",
    raw: {
      name,
      path,
      sha: item.sha,
      html_url: item.html_url,
      repository: item.repository,
      owner_login: ownerLogin
    },
    data_access_permissions: {
      public_repository: true,
      resume_document: true
    },
    resume_retrieval_permitted: false,
    source_attribution: {
      provider: "GitHub",
      api: "search/code",
      repository: repoFullName,
      terms_url: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service"
    },
    discovered_on: new Date().toISOString()
  };
}

module.exports = {
  buildGitHubUserSearchQuery,
  buildGitHubResumeCodeSearchQueries,
  buildRawGitHubContentUrl,
  isPublicResumeDocumentPath,
  mapGitHubUserProfile,
  mapGitHubResumeCodeHit
};
