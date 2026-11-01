/**
 * OTI Phase 4 — explicit connector permission model (never infer download from search).
 */

const DOCUMENT_RETRIEVAL_METHOD = Object.freeze({
  NONE: "none",
  LICENSED_API: "licensed_api",
  PROVIDER_SIGNED_URL: "provider_signed_url"
});

function buildPermissionProfile({
  providerKey,
  profileSearch = false,
  profileRead = false,
  resumeDownload = false,
  documentRetrievalMethod = DOCUMENT_RETRIEVAL_METHOD.NONE,
  licenseRequired = true,
  licenseConfigured = false,
  downloadLimitPerDay = null,
  supportedFormats = []
}) {
  return {
    provider_key: providerKey,
    profile_search_permitted: Boolean(profileSearch),
    profile_read_permitted: Boolean(profileRead),
    resume_download_permitted: Boolean(resumeDownload) && Boolean(licenseConfigured),
    document_retrieval_method: documentRetrievalMethod,
    license_required: Boolean(licenseRequired),
    license_configured: Boolean(licenseConfigured),
    download_limit_per_day: downloadLimitPerDay,
    supported_document_formats: supportedFormats
  };
}

function assertResumeDownloadPermitted(permissionProfile) {
  if (!permissionProfile?.resume_download_permitted) {
    const error = new Error("Resume download is not permitted for this provider.");
    error.status = 403;
    throw error;
  }

  if (permissionProfile.license_required && !permissionProfile.license_configured) {
    const error = new Error("Provider license or entitlement is not configured.");
    error.status = 403;
    throw error;
  }

  if (
    !permissionProfile.document_retrieval_method ||
    permissionProfile.document_retrieval_method === DOCUMENT_RETRIEVAL_METHOD.NONE
  ) {
    const error = new Error("No document retrieval method is available for this provider.");
    error.status = 403;
    throw error;
  }
}

module.exports = {
  DOCUMENT_RETRIEVAL_METHOD,
  buildPermissionProfile,
  assertResumeDownloadPermitted
};
