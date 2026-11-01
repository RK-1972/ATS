/**
 * OTI Phase 3 connector registry — provider-independent registration and capability routing.
 */

const { validateConnectorDefinition } = require("./otiConnectorContract");
const githubSearchConnector = require("./githubSearchConnector");
const bingWebSearchConnector = require("./bingWebSearchConnector");
const braveSearchConnector = require("./braveSearchConnector");
const serperSearchConnector = require("./serperSearchConnector");
const linkedInLicensedConnector = require("./linkedInLicensedConnector");
const licensedResumeConnector = require("./licensedResumeConnector");

const connectors = new Map();

function registerConnector(definition) {
  validateConnectorDefinition(definition);
  connectors.set(definition.providerKey, definition);
}

function bootstrapDefaultConnectors() {
  if (connectors.size > 0) {
    return;
  }

  for (const connector of [
    githubSearchConnector,
    bingWebSearchConnector,
    braveSearchConnector,
    serperSearchConnector,
    linkedInLicensedConnector,
    licensedResumeConnector
  ]) {
    registerConnector(connector);
  }
}

function listConnectors() {
  bootstrapDefaultConnectors();
  return Array.from(connectors.values());
}

function getConnector(providerKey) {
  bootstrapDefaultConnectors();
  return connectors.get(String(providerKey || "").trim()) || null;
}

function selectConnectors({ capabilities = [], providerKeys = [] } = {}) {
  bootstrapDefaultConnectors();

  const requiredCaps = new Set((capabilities || []).map((item) => String(item)));
  const requiredKeys = new Set((providerKeys || []).map((item) => String(item)));

  return listConnectors().filter((connector) => {
    if (requiredKeys.size > 0 && !requiredKeys.has(connector.providerKey)) {
      return false;
    }

    if (requiredCaps.size === 0) {
      return true;
    }

    return connector.capabilities.some((cap) => requiredCaps.has(cap));
  });
}

function sanitizeConnectorConfiguration(configuration = {}) {
  return {
    provider_key: configuration.provider_key || null,
    configured: Boolean(configuration.configured),
    licensing: configuration.licensing || null,
    resume_retrieval_permitted: Boolean(configuration.resume_retrieval_permitted),
    resume_retrieval_notes: configuration.resume_retrieval_notes || null
  };
}

async function describeConnectorCatalog({ publicView = false } = {}) {
  bootstrapDefaultConnectors();
  const catalog = [];

  for (const connector of listConnectors()) {
    const rawConfiguration = connector.getConfigurationState();
    const configuration = publicView
      ? sanitizeConnectorConfiguration(rawConfiguration)
      : rawConfiguration;
    let health = null;

    try {
      health = await connector.getHealth();
    } catch (error) {
      health = {
        provider_key: connector.providerKey,
        status: "unavailable",
        message: error.message
      };
    }

    const permissions =
      typeof connector.getPermissionProfile === "function"
        ? connector.getPermissionProfile()
        : null;

    catalog.push({
      provider_key: connector.providerKey,
      display_name: connector.displayName,
      capabilities: connector.capabilities,
      configuration,
      permissions,
      health
    });
  }

  return catalog;
}

function resetRegistryForTests() {
  connectors.clear();
}

module.exports = {
  registerConnector,
  bootstrapDefaultConnectors,
  listConnectors,
  getConnector,
  selectConnectors,
  sanitizeConnectorConfiguration,
  describeConnectorCatalog,
  resetRegistryForTests
};
