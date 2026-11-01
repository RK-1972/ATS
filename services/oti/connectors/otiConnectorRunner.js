/**
 * Executes searches across selected connectors with isolated error handling.
 */

const { SEARCH_OUTCOME } = require("./otiConnectorContract");
const { selectConnectors, getConnector } = require("./otiConnectorRegistry");

const PROVIDER_KEY_ALIASES = Object.freeze({
  serper: "serper_web_search",
  serper_web: "serper_web_search",
  google: "serper_web_search",
  bing: "bing_web_search",
  azure_bing: "bing_web_search",
  brave: "brave_search",
  linkedin: "linkedin_licensed"
});

function normalizeProviderKey(key) {
  const trimmed = String(key || "").trim();
  if (!trimmed) {
    return "";
  }

  const lower = trimmed.toLowerCase();
  return PROVIDER_KEY_ALIASES[lower] || trimmed;
}

function isConnectorConfigured(connector) {
  if (!connector || typeof connector.getConfigurationState !== "function") {
    return false;
  }

  try {
    return Boolean(connector.getConfigurationState()?.configured);
  } catch {
    return false;
  }
}

function resolveConnectorsForDiscovery({ capabilities = [], providerKeys = [] } = {}) {
  const normalizedKeys = (providerKeys || []).map(normalizeProviderKey).filter(Boolean);
  let selected = [];

  if (normalizedKeys.length > 0) {
    selected = normalizedKeys.map((key) => getConnector(key)).filter(Boolean);
    selected = selected.filter(isConnectorConfigured);
  }

  if (selected.length === 0) {
    selected = selectConnectors({ capabilities }).filter(isConnectorConfigured);
  }

  return selected;
}

async function runConnectorSearch(connector, context) {
  try {
    const result = await connector.searchProfiles(context);
    return {
      provider_key: connector.providerKey,
      outcome: result.outcome || SEARCH_OUTCOME.OK,
      profiles: result.profiles || [],
      message: result.message || null,
      retry_after_seconds: result.retry_after_seconds || null
    };
  } catch (error) {
    const code = error.connectorCode === "rate_limited" ? SEARCH_OUTCOME.RATE_LIMITED : SEARCH_OUTCOME.PROVIDER_ERROR;

    return {
      provider_key: connector.providerKey,
      outcome: code,
      profiles: [],
      message: error.message || "Connector search failed."
    };
  }
}

async function executeExternalDiscovery(context = {}) {
  const {
    queryText,
    structuredQuery,
    requisition,
    limitPerProvider = 10,
    capabilities = [],
    providerKeys = []
  } = context;

  const selected = resolveConnectorsForDiscovery({ capabilities, providerKeys });

  const connectorResults = [];
  const normalizedProfiles = [];

  const providerQueries = context.providerQueries || {};

  for (const connector of selected) {
    const providerQueryText =
      String(providerQueries[connector.providerKey] || providerQueries[connector.provider_key] || "").trim() ||
      queryText;

    const result = await runConnectorSearch(connector, {
      queryText: providerQueryText,
      structuredQuery,
      requisition,
      limit: limitPerProvider
    });

    connectorResults.push(result);

    if (result.outcome === SEARCH_OUTCOME.OK) {
      for (const profile of result.profiles) {
        normalizedProfiles.push(profile);
      }
    }
  }

  return {
    connector_results: connectorResults,
    raw_profiles: normalizedProfiles
  };
}

module.exports = {
  executeExternalDiscovery,
  runConnectorSearch,
  normalizeProviderKey,
  resolveConnectorsForDiscovery
};
