/**
 * Serper.dev — authorized Google Search API wrapper (web results metadata).
 * Requires SERPER_API_KEY or OTI_SERPER_API_KEY.
 */

const {
  CONNECTOR_CAPABILITIES,
  CONNECTOR_STATUS,
  SEARCH_OUTCOME
} = require("./otiConnectorContract");
const { assertWithinRateLimit } = require("./otiConnectorRateLimit");
const { connectorFetch } = require("./createHttpConnector");
const {
  buildSerperIndiaResumeSearches,
  buildWebSearchCandidateQuery,
  isResumeFocusedQuery,
  resolveSerperGeo
} = require("./otiWebSearchCandidateQuery");

const PROVIDER_KEY = "serper_web_search";
const MAX_SERPER_QUERY_VARIANTS = 3;

function readKey() {
  return String(process.env.SERPER_API_KEY || process.env.OTI_SERPER_API_KEY || "").trim();
}

function getConfigurationState() {
  return {
    provider_key: PROVIDER_KEY,
    configured: Boolean(readKey()),
    credential_source: "env:SERPER_API_KEY or env:OTI_SERPER_API_KEY",
    licensing: "Serper/Google Search API usage subject to provider terms.",
    resume_retrieval_permitted: false,
    resume_retrieval_notes: "Search snippets only; no scraping."
  };
}

async function getHealth() {
  if (!readKey()) {
    return {
      provider_key: PROVIDER_KEY,
      status: CONNECTOR_STATUS.NOT_CONFIGURED,
      message: "Serper API key is not set."
    };
  }

  return {
    provider_key: PROVIDER_KEY,
    status: CONNECTOR_STATUS.HEALTHY,
    message: "Serper API credentials present."
  };
}

function buildSearchPlan({ queryText, structuredQuery, requisition, limit }) {
  const providerQuery = String(queryText || "").trim();

  if (providerQuery && isResumeFocusedQuery(providerQuery)) {
    const geo = resolveSerperGeo();
    return [{ q: providerQuery, ...geo, num: Math.min(limit, 20) }];
  }

  return buildSerperIndiaResumeSearches({
    queryText: providerQuery,
    structuredQuery,
    requisition,
    limit
  }).slice(0, MAX_SERPER_QUERY_VARIANTS);
}

async function runSerperQuery(searchPlan) {
  const body = {
    q: searchPlan.q,
    num: searchPlan.num || 10
  };

  if (searchPlan.gl) {
    body.gl = searchPlan.gl;
  }

  if (searchPlan.hl) {
    body.hl = searchPlan.hl;
  }

  return connectorFetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": readKey()
    },
    body: JSON.stringify(body)
  });
}

async function searchProfiles({ queryText, structuredQuery, requisition, limit = 10 }) {
  if (!readKey()) {
    return {
      outcome: SEARCH_OUTCOME.NOT_CONFIGURED,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: "Serper connector is not configured."
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

  const searchPlans =
    buildSearchPlan({ queryText, structuredQuery, requisition, limit }) ||
    buildSerperIndiaResumeSearches({
      queryText: buildWebSearchCandidateQuery({ queryText, structuredQuery, requisition }),
      structuredQuery,
      requisition,
      limit
    });

  const organicByLink = new Map();

  for (const plan of searchPlans) {
    const response = await runSerperQuery(plan);

    if (response.status === 429) {
      return {
        outcome: SEARCH_OUTCOME.RATE_LIMITED,
        provider_key: PROVIDER_KEY,
        profiles: [],
        message: "Serper rate limit reached."
      };
    }

    if (!response.ok) {
      return {
        outcome: SEARCH_OUTCOME.PROVIDER_ERROR,
        provider_key: PROVIDER_KEY,
        profiles: [],
        message: `Serper search failed (${response.status}).`
      };
    }

    const organic = response.json?.organic || [];

    for (const row of organic) {
      const link = String(row.link || "").trim();

      if (!link || organicByLink.has(link)) {
        continue;
      }

      organicByLink.set(link, row);
    }

    if (organicByLink.size >= limit) {
      break;
    }
  }

  const organic = [...organicByLink.values()].slice(0, limit);

  return {
    outcome: SEARCH_OUTCOME.OK,
    provider_key: PROVIDER_KEY,
    profiles: organic.map((row, index) => ({
      provider_key: PROVIDER_KEY,
      source_record_id: String(row.link || index),
      profile_url: row.link || null,
      display_name: row.title || null,
      headline: row.snippet || null,
      current_role: null,
      organization: null,
      location: null,
      skills: [],
      experience_indicators: [],
      raw: row,
      data_access_permissions: { public_snippet: true },
      resume_retrieval_permitted: false,
      source_attribution: { provider: "Serper (Google Search API)", geo: "in" },
      discovered_on: new Date().toISOString()
    })),
    message: null
  };
}

module.exports = {
  providerKey: PROVIDER_KEY,
  displayName: "Serper Web Search",
  capabilities: [CONNECTOR_CAPABILITIES.WEB_SEARCH, CONNECTOR_CAPABILITIES.JOB_BOARD],
  getConfigurationState,
  getHealth,
  searchProfiles
};
