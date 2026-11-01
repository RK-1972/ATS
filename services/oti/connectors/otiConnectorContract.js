/**
 * OTI Phase 3 — provider-independent connector contract.
 */

const CONNECTOR_CAPABILITIES = Object.freeze({
  WEB_SEARCH: "web_search",
  PROFILE_SEARCH: "profile_search",
  GITHUB: "github",
  PORTFOLIO: "portfolio",
  JOB_BOARD: "job_board",
  PROFESSIONAL_NETWORK: "professional_network"
});

const CONNECTOR_STATUS = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  UNAVAILABLE: "unavailable",
  NOT_CONFIGURED: "not_configured"
});

const SEARCH_OUTCOME = Object.freeze({
  OK: "ok",
  NOT_CONFIGURED: "not_configured",
  RATE_LIMITED: "rate_limited",
  PROVIDER_ERROR: "provider_error",
  FORBIDDEN: "forbidden"
});

function httpConnectorError(message, code = SEARCH_OUTCOME.PROVIDER_ERROR) {
  const error = new Error(message);
  error.connectorCode = code;
  return error;
}

function validateConnectorDefinition(definition) {
  const required = [
    "providerKey",
    "displayName",
    "capabilities",
    "getConfigurationState",
    "getHealth",
    "searchProfiles"
  ];

  for (const key of required) {
    if (typeof definition[key] === "undefined") {
      throw new Error(`Connector definition missing required field: ${key}`);
    }
  }

  if (!Array.isArray(definition.capabilities) || definition.capabilities.length === 0) {
    throw new Error(`Connector ${definition.providerKey} must declare capabilities.`);
  }
}

module.exports = {
  CONNECTOR_CAPABILITIES,
  CONNECTOR_STATUS,
  SEARCH_OUTCOME,
  httpConnectorError,
  validateConnectorDefinition
};
