/**
 * Brave Search API — authorized web search.
 * Requires BRAVE_SEARCH_API_KEY or OTI_BRAVE_SEARCH_API_KEY.
 */

const {
  CONNECTOR_CAPABILITIES,
  CONNECTOR_STATUS,
  SEARCH_OUTCOME
} = require("./otiConnectorContract");
const { assertWithinRateLimit } = require("./otiConnectorRateLimit");
const { connectorFetch } = require("./createHttpConnector");
const { buildWebSearchCandidateQuery } = require("./otiWebSearchCandidateQuery");

const PROVIDER_KEY = "brave_search";

function readKey() {
  return String(process.env.BRAVE_SEARCH_API_KEY || process.env.OTI_BRAVE_SEARCH_API_KEY || "").trim();
}

function getConfigurationState() {
  const configured = Boolean(readKey());

  return {
    provider_key: PROVIDER_KEY,
    configured,
    credential_source: "env:BRAVE_SEARCH_API_KEY or env:OTI_BRAVE_SEARCH_API_KEY",
    licensing: "Brave Search API subscription required.",
    resume_retrieval_permitted: false,
    resume_retrieval_notes: "Returns authorized search snippets only."
  };
}

async function getHealth() {
  if (!readKey()) {
    return {
      provider_key: PROVIDER_KEY,
      status: CONNECTOR_STATUS.NOT_CONFIGURED,
      message: "Brave Search API key is not set."
    };
  }

  return {
    provider_key: PROVIDER_KEY,
    status: CONNECTOR_STATUS.HEALTHY,
    message: "Brave Search API credentials present."
  };
}

async function searchProfiles({ queryText, structuredQuery, requisition, limit = 10 }) {
  if (!readKey()) {
    return {
      outcome: SEARCH_OUTCOME.NOT_CONFIGURED,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: "Brave Search connector is not configured."
    };
  }

  try {
    assertWithinRateLimit(PROVIDER_KEY, { maxPerMinute: 30 });
  } catch (error) {
    return {
      outcome: SEARCH_OUTCOME.RATE_LIMITED,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: error.message
    };
  }

  const q =
    String(queryText || "").trim() ||
    buildWebSearchCandidateQuery({ queryText, structuredQuery, requisition });

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(Math.min(limit, 20)));

  const response = await connectorFetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": readKey()
    }
  });

  if (response.status === 429) {
    return {
      outcome: SEARCH_OUTCOME.RATE_LIMITED,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: "Brave Search rate limit reached."
    };
  }

  if (!response.ok) {
    return {
      outcome: SEARCH_OUTCOME.PROVIDER_ERROR,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: `Brave search failed (${response.status}).`
    };
  }

  const results = response.json?.web?.results || [];

  return {
    outcome: SEARCH_OUTCOME.OK,
    provider_key: PROVIDER_KEY,
    profiles: results.map((row, index) => ({
      provider_key: PROVIDER_KEY,
      source_record_id: String(row.url || index),
      profile_url: row.url || null,
      display_name: row.title || null,
      headline: row.description || null,
      current_role: null,
      organization: null,
      location: null,
      skills: [],
      experience_indicators: [],
      raw: row,
      data_access_permissions: { public_snippet: true },
      resume_retrieval_permitted: false,
      source_attribution: { provider: "Brave Search API" },
      discovered_on: new Date().toISOString()
    })),
    message: null
  };
}

module.exports = {
  providerKey: PROVIDER_KEY,
  displayName: "Brave Search",
  capabilities: [CONNECTOR_CAPABILITIES.WEB_SEARCH, CONNECTOR_CAPABILITIES.PORTFOLIO],
  getConfigurationState,
  getHealth,
  searchProfiles
};
