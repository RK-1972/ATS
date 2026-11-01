/**
 * Microsoft Bing Web Search API (authorized web discovery).
 * Requires AZURE_BING_SEARCH_KEY and optional AZURE_BING_SEARCH_ENDPOINT.
 */

const {
  CONNECTOR_CAPABILITIES,
  CONNECTOR_STATUS,
  SEARCH_OUTCOME
} = require("./otiConnectorContract");
const { assertWithinRateLimit } = require("./otiConnectorRateLimit");
const { connectorFetch } = require("./createHttpConnector");
const { buildWebSearchCandidateQuery } = require("./otiWebSearchCandidateQuery");

const PROVIDER_KEY = "bing_web_search";

function readConfig() {
  const key = String(process.env.AZURE_BING_SEARCH_KEY || process.env.OTI_BING_SEARCH_KEY || "").trim();
  const endpoint = String(
    process.env.AZURE_BING_SEARCH_ENDPOINT ||
      process.env.OTI_BING_SEARCH_ENDPOINT ||
      "https://api.bing.microsoft.com/v7.0/search"
  ).trim();

  return { key, endpoint };
}

function getConfigurationState() {
  const { key } = readConfig();

  return {
    provider_key: PROVIDER_KEY,
    configured: Boolean(key),
    credential_source: "env:AZURE_BING_SEARCH_KEY or env:OTI_BING_SEARCH_KEY",
    licensing: "Microsoft Bing Search API subscription required.",
    resume_retrieval_permitted: false,
    resume_retrieval_notes: "Web search returns public page metadata only."
  };
}

async function getHealth() {
  const config = getConfigurationState();

  if (!config.configured) {
    return {
      provider_key: PROVIDER_KEY,
      status: CONNECTOR_STATUS.NOT_CONFIGURED,
      message: "Bing Search API key is not set."
    };
  }

  return {
    provider_key: PROVIDER_KEY,
    status: CONNECTOR_STATUS.HEALTHY,
    message: "Bing Search API credentials present (live query validates quota)."
  };
}

async function searchProfiles({ queryText, structuredQuery, requisition, limit = 10 }) {
  const { key, endpoint } = readConfig();

  if (!key) {
    return {
      outcome: SEARCH_OUTCOME.NOT_CONFIGURED,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: "Bing Web Search connector is not configured."
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

  const url = new URL(endpoint);
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(Math.min(limit, 25)));

  const response = await connectorFetch(url.toString(), {
    headers: {
      "Ocp-Apim-Subscription-Key": key
    }
  });

  if (response.status === 429) {
    return {
      outcome: SEARCH_OUTCOME.RATE_LIMITED,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: "Bing Search API rate limit reached."
    };
  }

  if (!response.ok) {
    return {
      outcome: SEARCH_OUTCOME.PROVIDER_ERROR,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: `Bing search failed (${response.status}).`
    };
  }

  const webPages = response.json?.webPages?.value || [];

  return {
    outcome: SEARCH_OUTCOME.OK,
    provider_key: PROVIDER_KEY,
    profiles: webPages.map((page, index) => ({
      provider_key: PROVIDER_KEY,
      source_record_id: String(page.id || page.url || index),
      profile_url: page.url || null,
      display_name: page.name || null,
      headline: page.snippet || null,
      current_role: null,
      organization: null,
      location: null,
      skills: [],
      experience_indicators: [],
      raw: page,
      data_access_permissions: {
        public_snippet: true,
        full_page_scrape: false
      },
      resume_retrieval_permitted: false,
      source_attribution: {
        provider: "Microsoft Bing Web Search API",
        result_type: "web_page"
      },
      discovered_on: new Date().toISOString()
    })),
    message: null
  };
}

module.exports = {
  providerKey: PROVIDER_KEY,
  displayName: "Bing Web Search",
  capabilities: [CONNECTOR_CAPABILITIES.WEB_SEARCH, CONNECTOR_CAPABILITIES.PORTFOLIO],
  getConfigurationState,
  getHealth,
  searchProfiles
};
