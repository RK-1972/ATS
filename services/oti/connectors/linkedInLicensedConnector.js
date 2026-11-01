/**
 * LinkedIn / professional network connector placeholder.
 * Requires explicit licensing env flag — never simulates successful search.
 */

const {
  CONNECTOR_CAPABILITIES,
  CONNECTOR_STATUS,
  SEARCH_OUTCOME
} = require("./otiConnectorContract");

const PROVIDER_KEY = "linkedin_licensed";

function isLicensed() {
  const flag = String(process.env.OTI_LINKEDIN_API_LICENSED || "").trim().toLowerCase();
  const key = String(process.env.OTI_LINKEDIN_API_KEY || "").trim();
  return flag === "true" && Boolean(key);
}

function getConfigurationState() {
  return {
    provider_key: PROVIDER_KEY,
    configured: isLicensed(),
    credential_source: "env:OTI_LINKEDIN_API_LICENSED=true and env:OTI_LINKEDIN_API_KEY",
    licensing: "LinkedIn API access requires partner licensing; scraping is prohibited.",
    resume_retrieval_permitted: false,
    resume_retrieval_notes: "Licensed resume retrieval deferred to Phase 4."
  };
}

async function getHealth() {
  const config = getConfigurationState();

  if (!config.configured) {
    return {
      provider_key: PROVIDER_KEY,
      status: CONNECTOR_STATUS.NOT_CONFIGURED,
      message: "LinkedIn API licensing not configured."
    };
  }

  return {
    provider_key: PROVIDER_KEY,
    status: CONNECTOR_STATUS.DEGRADED,
    message: "LinkedIn adapter registered; Phase 3 does not ship licensed API integration."
  };
}

async function searchProfiles() {
  if (!isLicensed()) {
    return {
      outcome: SEARCH_OUTCOME.NOT_CONFIGURED,
      provider_key: PROVIDER_KEY,
      profiles: [],
      message: "LinkedIn connector requires OTI_LINKEDIN_API_LICENSED=true and API key."
    };
  }

  return {
    outcome: SEARCH_OUTCOME.FORBIDDEN,
    provider_key: PROVIDER_KEY,
    profiles: [],
    message: "LinkedIn search execution is not enabled until licensed integration is approved."
  };
}

module.exports = {
  providerKey: PROVIDER_KEY,
  displayName: "LinkedIn (Licensed API)",
  capabilities: [CONNECTOR_CAPABILITIES.PROFESSIONAL_NETWORK, CONNECTOR_CAPABILITIES.PROFILE_SEARCH],
  getConfigurationState,
  getHealth,
  searchProfiles
};
