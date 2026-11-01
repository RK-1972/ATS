/**
 * Licensed resume document provider (authorized API download only).
 * Requires OTI_LICENSED_RESUME_ENABLED=true and OTI_LICENSED_RESUME_API_KEY.
 */

const {
  CONNECTOR_CAPABILITIES,
  CONNECTOR_STATUS,
  SEARCH_OUTCOME
} = require("./otiConnectorContract");
const {
  DOCUMENT_RETRIEVAL_METHOD,
  buildPermissionProfile
} = require("./otiConnectorPermissions");
const { assertWithinRateLimit } = require("./otiConnectorRateLimit");
const { connectorFetch } = require("./createHttpConnector");

const PROVIDER_KEY = "licensed_resume";

function readConfig() {
  const enabled = String(process.env.OTI_LICENSED_RESUME_ENABLED || "").trim().toLowerCase() === "true";
  const apiKey = String(process.env.OTI_LICENSED_RESUME_API_KEY || "").trim();
  const apiUrl = String(process.env.OTI_LICENSED_RESUME_API_URL || "").trim();

  return { enabled, apiKey, apiUrl };
}

function getConfigurationState() {
  const { enabled, apiKey, apiUrl } = readConfig();
  const configured = enabled && Boolean(apiKey) && Boolean(apiUrl);

  return {
    provider_key: PROVIDER_KEY,
    configured,
    credential_source:
      "env:OTI_LICENSED_RESUME_ENABLED, OTI_LICENSED_RESUME_API_KEY, OTI_LICENSED_RESUME_API_URL",
    licensing: "Licensed resume API entitlement required.",
    resume_retrieval_permitted: configured,
    resume_retrieval_notes: "Downloads only via licensed API when explicitly granted."
  };
}

function getPermissionProfile() {
  const { enabled, apiKey } = readConfig();
  const licenseConfigured = enabled && Boolean(apiKey);

  return buildPermissionProfile({
    providerKey: PROVIDER_KEY,
    profileSearch: false,
    profileRead: licenseConfigured,
    resumeDownload: licenseConfigured,
    documentRetrievalMethod: licenseConfigured
      ? DOCUMENT_RETRIEVAL_METHOD.LICENSED_API
      : DOCUMENT_RETRIEVAL_METHOD.NONE,
    licenseRequired: true,
    licenseConfigured,
    downloadLimitPerDay: Number(process.env.OTI_LICENSED_RESUME_DAILY_LIMIT || 100),
    supportedFormats: ["pdf", "doc", "docx"]
  });
}

async function getHealth() {
  const config = getConfigurationState();

  if (!config.configured) {
    return {
      provider_key: PROVIDER_KEY,
      status: CONNECTOR_STATUS.NOT_CONFIGURED,
      message: "Licensed resume provider is not configured."
    };
  }

  return {
    provider_key: PROVIDER_KEY,
    status: CONNECTOR_STATUS.HEALTHY,
    message: "Licensed resume API credentials present."
  };
}

async function searchProfiles() {
  return {
    outcome: SEARCH_OUTCOME.NOT_CONFIGURED,
    provider_key: PROVIDER_KEY,
    profiles: [],
    message: "Licensed resume connector does not perform profile search."
  };
}

async function downloadLicensedDocument({ sourceRecordId, profileUrl, externalLeadId }) {
  const config = readConfig();
  const permissions = getPermissionProfile();

  if (!permissions.resume_download_permitted) {
    const error = new Error("Licensed resume download is not permitted.");
    error.status = 403;
    throw error;
  }

  assertWithinRateLimit(`${PROVIDER_KEY}:download`, { maxPerMinute: 20 });

  const { apiKey, apiUrl } = readConfig();

  const response = await connectorFetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      source_record_id: sourceRecordId,
      profile_url: profileUrl,
      external_lead_id: externalLeadId
    })
  });

  if (response.status === 429) {
    const error = new Error("Licensed resume provider rate limit reached.");
    error.status = 429;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`Licensed resume download failed (${response.status}).`);
    error.status = response.status >= 400 && response.status < 500 ? 403 : 502;
    throw error;
  }

  const base64 = response.json?.document_base64;
  if (!base64) {
    const error = new Error("Licensed resume provider returned no document payload.");
    error.status = 502;
    throw error;
  }

  return {
    buffer: Buffer.from(base64, "base64"),
    filename_hint: response.json?.filename || `${sourceRecordId}.pdf`,
    provenance: {
      provider: PROVIDER_KEY,
      source_record_id: sourceRecordId,
      profile_url: profileUrl,
      retrieval_method: DOCUMENT_RETRIEVAL_METHOD.LICENSED_API
    }
  };
}

module.exports = {
  providerKey: PROVIDER_KEY,
  displayName: "Licensed Resume API",
  capabilities: [CONNECTOR_CAPABILITIES.JOB_BOARD],
  getConfigurationState,
  getPermissionProfile,
  getHealth,
  searchProfiles,
  downloadLicensedDocument
};
