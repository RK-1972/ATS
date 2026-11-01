"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { buildPermissionProfile } = require("../services/oti/connectors/otiConnectorPermissions");
const otiConnectorRegistry = require("../services/oti/connectors/otiConnectorRegistry");
const otiExternalResumeRetrievalService = require("../services/oti/otiExternalResumeRetrievalService");
const otiResumeStorageService = require("../services/oti/otiResumeStorageService");
const { CONNECTOR_CAPABILITIES, CONNECTOR_STATUS } = require("../services/oti/connectors/otiConnectorContract");
const { resetRateLimitsForTests } = require("../services/oti/connectors/otiConnectorRateLimit");
const { validateResumeDocument } = require("../services/oti/otiResumeDocumentValidation");

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

function registerLicensedConnector() {
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
}

beforeEach(() => {
  resetRateLimitsForTests();
  registerLicensedConnector();
});

describe("oti retrieval orphan upload cleanup", () => {
  it("deletes only the newly uploaded object when completion loses the race", async () => {
    const state = { grant: null, deletedKeys: [], uploadedKey: null };

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
        return { rows: state.grant ? [{ ...state.grant }] : [] };
      }
      if (text.includes("UPDATE oti_resume_retrieval_grant")) {
        if (params[1] === "completed") {
          return { rowCount: 0, rows: [] };
        }
        if (state.grant && params[1]) {
          state.grant = {
            ...state.grant,
            status: params[1],
            attempt_count: params[6] ? state.grant.attempt_count + 1 : state.grant.attempt_count
          };
        }
        return { rowCount: 1, rows: [{ grant_id: 100 }] };
      }
      if (text.includes("FROM oti_external_resume_document") && text.includes("content_hash")) {
        return { rows: [] };
      }
      if (text.includes("UPDATE oti_external_lead")) {
        return { rows: [] };
      }
      return undefined;
    });

    const canonicalKey = otiResumeStorageService.buildExternalResumeObjectKey(
      10,
      validateResumeDocument(MIN_PDF, { allowedFormats: ["pdf"] }).content_hash,
      "pdf"
    );

    await assert.rejects(
      () =>
        otiExternalResumeRetrievalService.executeLicensedRetrieval(
          pool,
          10,
          { user: { employee_code: "REC-1", role_name: "Recruiter", full_name: "Rec" } },
          { requisition_code: "REQ-1" },
          {
            uploadResumeBuffer: async (key) => {
              state.uploadedKey = key;
            },
            deleteUploadedResumeObject: async (key) => {
              state.deletedKeys.push(key);
            }
          }
        ),
      (error) => error.status === 403
    );

    const expectedStagingKey = otiResumeStorageService.buildRetrievalGrantStagingObjectKey(
      10,
      state.grant.grant_uuid,
      validateResumeDocument(MIN_PDF, { allowedFormats: ["pdf"] }).content_hash,
      "pdf"
    );

    assert.equal(state.uploadedKey, expectedStagingKey);
    assert.deepEqual(state.deletedKeys, [expectedStagingKey]);
    assert.notEqual(state.deletedKeys[0], canonicalKey);
  });

  it("does not delete storage when the content hash is already linked", async () => {
    const validation = validateResumeDocument(MIN_PDF, { allowedFormats: ["pdf"] });
    const storageKey = otiResumeStorageService.buildExternalResumeObjectKey(
      10,
      validation.content_hash,
      "pdf"
    );
    const state = { grant: null, deletedKeys: [] };

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
        return { rows: state.grant ? [{ ...state.grant }] : [] };
      }
      if (text.includes("UPDATE oti_resume_retrieval_grant")) {
        if (params[1] === "completed") {
          return { rowCount: 0, rows: [] };
        }
        if (state.grant && params[1]) {
          state.grant = {
            ...state.grant,
            status: params[1],
            attempt_count: params[6] ? state.grant.attempt_count + 1 : state.grant.attempt_count
          };
        }
        return { rowCount: 1, rows: [{ grant_id: 100 }] };
      }
      if (text.includes("FROM oti_external_resume_document") && text.includes("content_hash")) {
        return {
          rows: [{ document_id: 501, storage_key: storageKey }]
        };
      }
      if (text.includes("UPDATE oti_external_lead")) {
        return { rows: [] };
      }
      return undefined;
    });

    await assert.rejects(
      () =>
        otiExternalResumeRetrievalService.executeLicensedRetrieval(
          pool,
          10,
          { user: { employee_code: "REC-1", role_name: "Recruiter", full_name: "Rec" } },
          { requisition_code: "REQ-1" },
          {
            uploadResumeBuffer: async () => {},
            deleteUploadedResumeObject: async (key) => {
              state.deletedKeys.push(key);
            }
          }
        ),
      (error) => error.status === 403
    );

    assert.deepEqual(state.deletedKeys, []);
  });

  it("preserves the lifecycle failure when cleanup delete fails", async () => {
    const state = { grant: null, deleteAttempts: 0 };

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
        return { rows: state.grant ? [{ ...state.grant }] : [] };
      }
      if (text.includes("UPDATE oti_resume_retrieval_grant")) {
        if (params[1] === "completed") {
          return { rowCount: 0, rows: [] };
        }
        if (state.grant && params[1]) {
          state.grant = {
            ...state.grant,
            status: params[1],
            attempt_count: params[6] ? state.grant.attempt_count + 1 : state.grant.attempt_count
          };
        }
        return { rowCount: 1, rows: [{ grant_id: 100 }] };
      }
      if (text.includes("FROM oti_external_resume_document") && text.includes("content_hash")) {
        return { rows: [] };
      }
      if (text.includes("UPDATE oti_external_lead")) {
        return { rows: [] };
      }
      return undefined;
    });

    await assert.rejects(
      () =>
        otiExternalResumeRetrievalService.executeLicensedRetrieval(
          pool,
          10,
          { user: { employee_code: "REC-1", role_name: "Recruiter", full_name: "Rec" } },
          { requisition_code: "REQ-1" },
          {
            uploadResumeBuffer: async () => {},
            deleteUploadedResumeObject: async () => {
              state.deleteAttempts += 1;
              throw new Error("R2 delete unavailable");
            }
          }
        ),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /no longer active/i);
        return true;
      }
    );

    assert.equal(state.deleteAttempts, 1);
  });

  it("never deletes the canonical object when completion fails after staging upload", async () => {
    const validation = validateResumeDocument(MIN_PDF, { allowedFormats: ["pdf"] });
    const canonicalKey = otiResumeStorageService.buildExternalResumeObjectKey(
      10,
      validation.content_hash,
      "pdf"
    );
    const state = { grant: null, deletedKeys: [], linkedChecks: 0 };

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
        return { rows: state.grant ? [{ ...state.grant }] : [] };
      }
      if (text.includes("UPDATE oti_resume_retrieval_grant")) {
        if (params[1] === "completed") {
          return { rowCount: 0, rows: [] };
        }
        if (state.grant && params[1]) {
          state.grant = {
            ...state.grant,
            status: params[1],
            attempt_count: params[6] ? state.grant.attempt_count + 1 : state.grant.attempt_count
          };
        }
        return { rowCount: 1, rows: [{ grant_id: 100 }] };
      }
      if (text.includes("FROM oti_external_resume_document")) {
        state.linkedChecks += 1;
        if (state.linkedChecks >= 3) {
          return {
            rows: [{ document_id: 777, storage_key: canonicalKey }]
          };
        }
        return { rows: [] };
      }
      if (text.includes("UPDATE oti_external_lead")) {
        return { rows: [] };
      }
      return undefined;
    });

    await assert.rejects(
      () =>
        otiExternalResumeRetrievalService.executeLicensedRetrieval(
          pool,
          10,
          { user: { employee_code: "REC-1", role_name: "Recruiter", full_name: "Rec" } },
          { requisition_code: "REQ-1" },
          {
            uploadResumeBuffer: async () => {},
            deleteUploadedResumeObject: async (key) => {
              state.deletedKeys.push(key);
            }
          }
        ),
      (error) => error.status === 403
    );

    assert.ok(state.deletedKeys.length >= 1);
    assert.ok(state.deletedKeys.every((key) => key.includes("/retrieval-grants/")));
    assert.ok(!state.deletedKeys.includes(canonicalKey));
  });

  it("publishes staged bytes to the canonical key on successful completion", async () => {
    const validation = validateResumeDocument(MIN_PDF, { allowedFormats: ["pdf"] });
    const canonicalKey = otiResumeStorageService.buildExternalResumeObjectKey(
      10,
      validation.content_hash,
      "pdf"
    );
    const state = { grant: null, uploadedKeys: [], deletedKeys: [] };

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
        return { rows: state.grant ? [{ ...state.grant }] : [] };
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
      if (text.includes("FROM oti_external_resume_document")) {
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
      if (text.includes("oti_external_resume_index")) {
        return { rows: [{ extraction_status: "indexed" }] };
      }
      if (text.includes("UPDATE oti_external_lead")) {
        return { rows: [] };
      }
      if (text.includes("UPDATE oti_external_lead_source")) {
        return { rows: [] };
      }
      return undefined;
    });

    const stagingKey = otiResumeStorageService.buildRetrievalGrantStagingObjectKey(
      10,
      "grant-preview",
      validation.content_hash,
      "pdf"
    );

    const result = await otiExternalResumeRetrievalService.executeLicensedRetrieval(
      pool,
      10,
      { user: { employee_code: "REC-1", role_name: "Recruiter", full_name: "Rec" } },
      { requisition_code: "REQ-1" },
      {
        uploadResumeBuffer: async (key) => {
          state.uploadedKeys.push(key);
        },
        deleteUploadedResumeObject: async (key) => {
          state.deletedKeys.push(key);
        },
        extractResumeText: async () => ({ ok: false, status: "failed", reason: "test skip extract" })
      }
    );

    assert.equal(result.status, "completed");
    assert.equal(state.uploadedKeys[0], stagingKey.replace("grant-preview", state.grant.grant_uuid));
    assert.equal(state.uploadedKeys.at(-1), canonicalKey);
    assert.deepEqual(state.deletedKeys, [state.uploadedKeys[0]]);
  });

  it("skips canonical republish when a concurrent attempt links the document first", async () => {
    const validation = validateResumeDocument(MIN_PDF, { allowedFormats: ["pdf"] });
    const canonicalKey = otiResumeStorageService.buildExternalResumeObjectKey(
      10,
      validation.content_hash,
      "pdf"
    );
    const state = { grant: null, uploadedKeys: [], deletedKeys: [], linkedChecks: 0 };

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
        return { rows: state.grant ? [{ ...state.grant }] : [] };
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
      if (text.includes("FROM oti_external_resume_document")) {
        state.linkedChecks += 1;
        if (state.linkedChecks >= 3) {
          return {
            rows: [
              {
                document_id: 888,
                storage_key: canonicalKey,
                content_hash: validation.content_hash,
                detected_format: "pdf",
                byte_length: MIN_PDF.length
              }
            ]
          };
        }
        return { rows: [] };
      }
      if (text.includes("INSERT INTO oti_external_resume_document")) {
        throw new Error("Should not insert when concurrent link exists");
      }
      if (text.includes("oti_external_resume_index")) {
        return { rows: [{ extraction_status: "indexed" }] };
      }
      if (text.includes("UPDATE oti_external_lead")) {
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
        uploadResumeBuffer: async (key) => {
          state.uploadedKeys.push(key);
        },
        deleteUploadedResumeObject: async (key) => {
          state.deletedKeys.push(key);
        },
        extractResumeText: async () => ({ ok: false, status: "failed", reason: "test skip extract" })
      }
    );

    assert.equal(result.status, "completed");
    assert.equal(result.document.document_id, 888);
    assert.equal(state.uploadedKeys.length, 1);
    assert.ok(state.uploadedKeys[0].includes("/retrieval-grants/"));
    assert.ok(!state.uploadedKeys.includes(canonicalKey));
    assert.deepEqual(state.deletedKeys, [state.uploadedKeys[0]]);
  });
});
