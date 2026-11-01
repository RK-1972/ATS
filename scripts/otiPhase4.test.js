"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { validateResumeDocument } = require("../services/oti/otiResumeDocumentValidation");
const { buildPermissionProfile, assertResumeDownloadPermitted } = require("../services/oti/connectors/otiConnectorPermissions");
const otiResumeRetrievalGrantService = require("../services/oti/otiResumeRetrievalGrantService");
const otiExternalResumeRetrievalService = require("../services/oti/otiExternalResumeRetrievalService");
const otiConnectorRegistry = require("../services/oti/connectors/otiConnectorRegistry");
const { CONNECTOR_CAPABILITIES, CONNECTOR_STATUS } = require("../services/oti/connectors/otiConnectorContract");
const licensedResumeConnector = require("../services/oti/connectors/licensedResumeConnector");
const { resetRateLimitsForTests } = require("../services/oti/connectors/otiConnectorRateLimit");

const MIN_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");

function buildPlatformPool(extraHandler) {
  return {
    query: async (sql, params) => {
      const text = String(sql);

      if (typeof extraHandler === "function") {
        const handled = await extraHandler(text, params);
        if (handled !== undefined) {
          return handled;
        }
      }

      if (text.includes("published_payload")) {
        return {
          rows: [
            {
              published_payload: {
                modules: [{ key: "ai", enabled: true }],
                ai_features: [{ key: "talent_intelligence", enabled: true }]
              }
            }
          ]
        };
      }

      if (text.includes("INSERT INTO md_enterprise_audit")) {
        return { rows: [] };
      }

      if (text.includes("INSERT INTO oti_resume_retrieval_event")) {
        return { rows: [] };
      }

      return { rows: [] };
    }
  };
}

beforeEach(() => {
  resetRateLimitsForTests();
  otiConnectorRegistry.resetRegistryForTests();
  otiConnectorRegistry.bootstrapDefaultConnectors();
});

describe("oti phase4 document validation", () => {
  it("accepts PDF by magic bytes regardless of filename", () => {
    const result = validateResumeDocument(MIN_PDF, {
      filenameHint: "resume.exe",
      allowedFormats: ["pdf"]
    });

    assert.equal(result.ok, true);
    assert.equal(result.format, "pdf");
  });

  it("rejects unknown binary payloads", () => {
    const result = validateResumeDocument(Buffer.from("not-a-document"), {
      allowedFormats: ["pdf", "doc", "docx"]
    });

    assert.equal(result.ok, false);
  });
});

describe("oti phase4 permission model", () => {
  it("never infers download permission from profile search", () => {
    const permissions = buildPermissionProfile({
      providerKey: "github",
      profileSearch: true,
      profileRead: true,
      resumeDownload: false,
      licenseConfigured: true
    });

    assert.equal(permissions.resume_download_permitted, false);
    assert.throws(() => assertResumeDownloadPermitted(permissions), (error) => error.status === 403);
  });

  it("requires license configuration for licensed providers", () => {
    const permissions = buildPermissionProfile({
      providerKey: "licensed_resume",
      profileSearch: false,
      profileRead: true,
      resumeDownload: true,
      documentRetrievalMethod: "licensed_api",
      licenseRequired: true,
      licenseConfigured: false
    });

    assert.throws(() => assertResumeDownloadPermitted(permissions), (error) => error.status === 403);
  });
});

describe("oti phase4 retrieval grants", () => {
  it("prevents replay after grant completion", async () => {
    const grant = {
      grant_id: 1,
      grant_uuid: "grant-1",
      external_lead_id: 10,
      requested_by: "REC-1",
      status: "completed",
      expires_on: new Date(Date.now() + 60000),
      consumed_on: new Date(),
      replay_nonce: "nonce-1",
      attempt_count: 1,
      max_attempts: 1
    };

    assert.throws(
      () =>
        otiResumeRetrievalGrantService.assertGrantExecutable(grant, {
          requestedBy: "REC-1",
          replayNonce: "nonce-1"
        }),
      (error) => error.status === 409
    );
  });

  it("rejects invalid replay nonce", () => {
    const grant = {
      grant_id: 2,
      requested_by: "REC-1",
      status: "pending",
      expires_on: new Date(Date.now() + 60000),
      replay_nonce: "expected",
      attempt_count: 0,
      max_attempts: 1
    };

    assert.throws(
      () =>
        otiResumeRetrievalGrantService.assertGrantExecutable(grant, {
          requestedBy: "REC-1",
          replayNonce: "wrong"
        }),
      (error) => error.status === 403
    );
  });
});

describe("oti phase4 licensed retrieval workflow", () => {
  it("stores document in R2 and indexes without auto registration", async () => {
    otiConnectorRegistry.resetRegistryForTests();
    otiConnectorRegistry.registerConnector({
      providerKey: "licensed_resume",
      displayName: "Licensed Test",
      capabilities: [CONNECTOR_CAPABILITIES.JOB_BOARD],
      getConfigurationState: () => ({ configured: true, resume_retrieval_permitted: true }),
      getPermissionProfile: () =>
        buildPermissionProfile({
          providerKey: "licensed_resume",
          profileRead: true,
          resumeDownload: true,
          documentRetrievalMethod: "licensed_api",
          licenseRequired: true,
          licenseConfigured: true,
          supportedFormats: ["pdf"]
        }),
      getHealth: async () => ({ status: CONNECTOR_STATUS.HEALTHY }),
      searchProfiles: async () => ({ outcome: "not_configured", profiles: [] }),
      downloadLicensedDocument: async () => ({
        buffer: MIN_PDF,
        filename_hint: "candidate.pdf",
        provenance: { provider: "licensed_resume" }
      })
    });

    const state = { uploaded: false, indexed: false, grant: null };

    const pool = buildPlatformPool((text, params) => {
      if (text.includes("FROM oti_external_lead WHERE external_lead_id")) {
        return { rows: [{ external_lead_id: 10, import_status: "staged" }] };
      }
      if (text.includes("FROM oti_external_lead_source")) {
        return {
          rows: [
            {
              provider_key: "licensed_resume",
              source_record_id: "SRC-1",
              profile_url: "https://provider.example/p/SRC-1",
              resume_retrieval_permitted: true,
              source_attribution: { provider: "Licensed Test" }
            }
          ]
        };
      }
      if (text.includes("FROM rm_requisitions")) {
        return {
          rows: [
            {
              requisition_code: "REQ-1",
              req_status: "Approved",
              fulfillment_status: "Open",
              primary_skill: "Java"
            }
          ]
        };
      }
      if (text.includes("FROM rm_recruiter_assignments")) {
        return { rows: [{ assignment_id: 1 }] };
      }
      if (text.includes("oti_external_run_lead")) {
        return { rows: [{ linked: true }] };
      }
      if (text.includes("INSERT INTO oti_resume_retrieval_grant")) {
        state.grant = {
          grant_id: 100,
          grant_uuid: params[0],
          external_lead_id: 10,
          requested_by: "REC-1",
          status: "pending",
          expires_on: new Date(Date.now() + 600000),
          replay_nonce: params[5],
          attempt_count: 0,
          max_attempts: 1,
          revoked_on: null,
          consumed_on: null
        };
        return { rows: [state.grant] };
      }
      if (text.includes("FROM oti_resume_retrieval_grant WHERE grant_id")) {
        if (!state.grant) {
          return { rows: [] };
        }
        return { rows: [{ ...state.grant }] };
      }
      if (text.includes("UPDATE oti_resume_retrieval_grant")) {
        if (state.grant && params[1]) {
          state.grant = {
            ...state.grant,
            status: params[1],
            attempt_count: params[6] ? state.grant.attempt_count + 1 : state.grant.attempt_count
          };
        }
        return { rowCount: 1, rows: [{ grant_id: 100 }] };
      }
      if (text.includes("UPDATE oti_external_lead")) {
        return { rows: [] };
      }
      if (text.includes("INSERT INTO oti_external_resume_document")) {
        return {
          rows: [
            {
              document_id: 501,
              external_lead_id: 10,
              storage_key: params[3],
              content_hash: params[4],
              detected_format: "pdf",
              byte_length: MIN_PDF.length
            }
          ]
        };
      }
      if (text.includes("FROM oti_external_resume_document") && text.includes("content_hash")) {
        return { rows: [] };
      }
      if (text.includes("oti_external_resume_index")) {
        state.indexed = true;
        return { rows: [{ extraction_status: "indexed" }] };
      }
      if (text.includes("INSERT INTO oti_external_recruiter_action")) {
        return { rows: [] };
      }
      if (text.includes("UPDATE oti_external_lead_source")) {
        return { rows: [] };
      }
      return undefined;
    });

    const result = await otiExternalResumeRetrievalService.executeLicensedRetrieval(
      pool,
      10,
      { user: { employee_code: "REC-1", role_name: "Recruiter", full_name: "Rec" } },
      { requisition_code: "REQ-1" },
      {
        uploadResumeBuffer: async () => {
          state.uploaded = true;
          return { bucket: "test", key: "oti/external-leads/10/hash.pdf" };
        },
        downloadResumeBuffer: async () => MIN_PDF,
        extractResumeText: async () => ({ ok: false, status: "failed", reason: "test skip extract" })
      }
    );

    assert.equal(result.auto_registration, false);
    assert.equal(result.status, "completed");
    assert.equal(state.uploaded, true);
    assert.equal(state.indexed, true);
  });

  it("reports licensed provider as not configured without env", () => {
    const previous = process.env.OTI_LICENSED_RESUME_ENABLED;
    delete process.env.OTI_LICENSED_RESUME_ENABLED;
    delete process.env.OTI_LICENSED_RESUME_API_KEY;

    const permissions = licensedResumeConnector.getPermissionProfile();
    assert.equal(permissions.resume_download_permitted, false);

    if (previous) {
      process.env.OTI_LICENSED_RESUME_ENABLED = previous;
    }
  });
});
