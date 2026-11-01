/**
 * GitHub Search API — users (India-relevant) + public repository resume/CV documents.
 * Requires GITHUB_TOKEN or OTI_GITHUB_TOKEN (public API rate limits).
 */

const {
  CONNECTOR_CAPABILITIES,
  CONNECTOR_STATUS,
  SEARCH_OUTCOME
} = require("./otiConnectorContract");
const { assertWithinRateLimit } = require("./otiConnectorRateLimit");
const { connectorFetch } = require("./createHttpConnector");
const {
  DOCUMENT_RETRIEVAL_METHOD,
  buildPermissionProfile
} = require("./otiConnectorPermissions");
const {
  buildGitHubUserSearchQuery,
  buildGitHubResumeCodeSearchQueries,
  mapGitHubUserProfile,
  mapGitHubResumeCodeHit
} = require("./githubResumeDiscovery");

const PROVIDER_KEY = "github";
const MAX_CODE_SEARCH_VARIANTS = 4;

function readToken() {
  return String(process.env.GITHUB_TOKEN || process.env.OTI_GITHUB_TOKEN || "").trim();
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${readToken()}`,
    "User-Agent": "Optalynx-OTI"
  };
}

function getConfigurationState() {
  const token = readToken();

  return {
    provider_key: PROVIDER_KEY,
    configured: Boolean(token),
    credential_source: "env:GITHUB_TOKEN or env:OTI_GITHUB_TOKEN",
    licensing: "GitHub API Terms of Service; authenticated search rate limits apply.",
    resume_retrieval_permitted: false,
    resume_retrieval_notes:
      "Public resume/CV files are retrieved via HTTPS raw content URLs when published in public repositories."
  };
}

function getPermissionProfile() {
  const configured = Boolean(readToken());

  return buildPermissionProfile({
    providerKey: PROVIDER_KEY,
    profileSearch: configured,
    profileRead: configured,
    resumeDownload: false,
    documentRetrievalMethod: DOCUMENT_RETRIEVAL_METHOD.NONE,
    licenseRequired: false,
    licenseConfigured: configured,
    supportedFormats: ["pdf", "doc", "docx"]
  });
}

async function getHealth() {
  const config = getConfigurationState();

  if (!config.configured) {
    return {
      provider_key: PROVIDER_KEY,
      status: CONNECTOR_STATUS.NOT_CONFIGURED,
      message: "GITHUB_TOKEN is not set."
    };
  }

  const response = await connectorFetch("https://api.github.com/rate_limit", {
    headers: githubHeaders()
  });

  if (!response.ok) {
    return {
      provider_key: PROVIDER_KEY,
      status: CONNECTOR_STATUS.UNAVAILABLE,
      message: `GitHub health check failed (${response.status}).`
    };
  }

  return {
    provider_key: PROVIDER_KEY,
    status: CONNECTOR_STATUS.HEALTHY,
    message: "GitHub API reachable.",
    rate_limit: response.json?.resources?.search || null
  };
}

async function searchGitHubUsers({ queryText, structuredQuery, requisition, limit }) {
  const q = buildGitHubUserSearchQuery({ queryText, structuredQuery, requisition });
  const url = new URL("https://api.github.com/search/users");
  url.searchParams.set("q", q);
  url.searchParams.set("per_page", String(Math.min(limit, 20)));

  const response = await connectorFetch(url.toString(), {
    headers: githubHeaders()
  });

  if (response.status === 403 || response.status === 429) {
    return { rateLimited: true, items: [], query: q };
  }

  if (!response.ok) {
    return { error: true, items: [], query: q, status: response.status };
  }

  return {
    items: response.json?.items || [],
    query: q
  };
}

async function searchGitHubCode(query, perPage) {
  const url = new URL("https://api.github.com/search/code");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(Math.min(perPage, 20)));

  const response = await connectorFetch(url.toString(), {
    headers: {
      ...githubHeaders(),
      Accept: "application/vnd.github.text-match+json"
    }
  });

  if (response.status === 403 || response.status === 429) {
    return { rateLimited: true, items: [] };
  }

  if (!response.ok) {
    return {
      error: true,
      items: [],
      status: response.status,
      message: response.json?.message || response.json?.errors?.[0]?.message || null
    };
  }

  return { items: response.json?.items || [] };
}

function summarizeCodeSearchErrors(errors = []) {
  if (!errors.length) {
    return null;
  }

  const first = errors[0];
  const status = first.status || "error";
  const detail = first.message ? `: ${first.message}` : "";

  if (errors.length === 1) {
    return `GitHub code search failed (HTTP ${status}${detail}).`;
  }

  return `GitHub code search failed (HTTP ${status}${detail}); ${errors.length - 1} additional error(s).`;
}

async function searchProfiles({ queryText, structuredQuery, requisition, limit = 10 }) {
  const config = getConfigurationState();

  if (!config.configured) {
    return {
      outcome: SEARCH_OUTCOME.NOT_CONFIGURED,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: "GitHub connector is not configured."
    };
  }

  try {
    assertWithinRateLimit(PROVIDER_KEY, { maxPerMinute: 20 });
  } catch (error) {
    return {
      outcome: SEARCH_OUTCOME.RATE_LIMITED,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: error.message,
      retry_after_seconds: error.retryAfterSeconds || 60
    };
  }

  const userSearch = await searchGitHubUsers({
    queryText,
    structuredQuery,
    requisition,
    limit
  });

  if (userSearch.rateLimited) {
    return {
      outcome: SEARCH_OUTCOME.RATE_LIMITED,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: "GitHub API rate limit reached during user search."
    };
  }

  if (userSearch.error) {
    return {
      outcome: SEARCH_OUTCOME.PROVIDER_ERROR,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: `GitHub user search failed (${userSearch.status}).`
    };
  }

  const userProfiles = userSearch.items.map(mapGitHubUserProfile);
  const userLogins = userSearch.items.map((item) => item.login).filter(Boolean);
  const codeQueries = buildGitHubResumeCodeSearchQueries({
    structuredQuery,
    queryText,
    requisition,
    userLogins
  }).slice(0, MAX_CODE_SEARCH_VARIANTS);

  const resumeProfiles = [];
  const seenResumeUrls = new Set();
  const codeSearchErrors = [];

  for (const codeQuery of codeQueries) {
    try {
      assertWithinRateLimit(PROVIDER_KEY, { maxPerMinute: 20 });
    } catch (error) {
      break;
    }

    const codeSearch = await searchGitHubCode(codeQuery, Math.max(5, Math.ceil(limit / 2)));

    if (codeSearch.rateLimited) {
      codeSearchErrors.push({
        query: codeQuery,
        status: 403,
        message: "GitHub API rate limit reached during code search."
      });
      continue;
    }

    if (codeSearch.error) {
      codeSearchErrors.push({
        query: codeQuery,
        status: codeSearch.status,
        message: codeSearch.message || `HTTP ${codeSearch.status}`
      });
      continue;
    }

    for (const item of codeSearch.items) {
      const profile = mapGitHubResumeCodeHit(item);

      if (!profile?.profile_url) {
        continue;
      }

      const dedupeKey = profile.profile_url.toLowerCase();

      if (seenResumeUrls.has(dedupeKey)) {
        continue;
      }

      seenResumeUrls.add(dedupeKey);
      resumeProfiles.push(profile);
    }
  }

  const profiles = [...resumeProfiles, ...userProfiles];
  const codeSearchMessage = summarizeCodeSearchErrors(codeSearchErrors);

  return {
    outcome: SEARCH_OUTCOME.OK,
    provider_key: PROVIDER_KEY,
    profiles,
    message: codeSearchMessage,
    code_search_errors: codeSearchErrors,
    discovery_summary: {
      github_user_query: userSearch.query,
      github_users: userProfiles.length,
      github_resume_documents: resumeProfiles.length,
      github_code_queries: codeQueries,
      github_code_search_errors: codeSearchErrors
    }
  };
}

module.exports = {
  providerKey: PROVIDER_KEY,
  displayName: "GitHub",
  capabilities: [CONNECTOR_CAPABILITIES.GITHUB, CONNECTOR_CAPABILITIES.PROFILE_SEARCH],
  getConfigurationState,
  getPermissionProfile,
  getHealth,
  searchProfiles,
  buildGitHubUserSearchQuery,
  buildGitHubResumeCodeSearchQueries
};
