"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

const otiCapabilityAuth = require("../services/oti/otiCapabilityAuth");
const otiExternalRecruiterActionService = require("../services/oti/otiExternalRecruiterActionService");
const otiExternalResumeRetrievalService = require("../services/oti/otiExternalResumeRetrievalService");
const otiResumeRetrievalGrantService = require("../services/oti/otiResumeRetrievalGrantService");
const otiConnectorRegistry = require("../services/oti/connectors/otiConnectorRegistry");
const resumeMatchService = require("../services/resumeMatchService");

function buildPlatformConfig() {
  return {
    modules: [{ key: "ai", enabled: true }],
    ai_features: [{ key: "talent_intelligence", enabled: true }]
  };
}

const approvedReq = {
  requisition_code: "REQ-1",
  req_status: "Approved",
  primary_skill: "Java",
  fulfillment_status: "Open"
};

function assignmentRows(flag) {
  return [
    {
      assignment_code: "TALENT_INTELLIGENCE",
      is_active: true,
      master_is_active: true,
      workspace_flag: flag
    }
  ];
}

describe("oti auth hardening — external lead context", () => {
  it("denies retrieval status without run_id or requisition_code", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        otiExternalResumeRetrievalService.getResumeRetrievalStatus(
          pool,
          42,
          { user: { employee_code: "REC-1", role_name: "Recruiter" }, query: {} }
        ),
      (error) => error.status === 403
    );
  });

  it("denies external lead action without run/requisition context", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM oti_external_lead")) {
          return { rows: [{ external_lead_id: 42, import_status: "staged" }] };
        }
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        otiExternalRecruiterActionService.recordExternalLeadAction(
          pool,
          42,
          { user: { employee_code: "REC-1", role_name: "Recruiter" } },
          { action_type: "shortlist" }
        ),
      (error) => error.status === 403
    );
  });

  it("denies cross-requisition external lead access", async () => {
    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {});

    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM oti_external_lead")) {
          return { rows: [{ external_lead_id: 42, import_status: "staged" }] };
        }
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (text.includes("rm_requisitions")) {
          return { rows: [approvedReq] };
        }
        if (text.includes("oti_external_run_lead")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        otiExternalRecruiterActionService.recordExternalLeadAction(
          pool,
          42,
          { user: { employee_code: "REC-1", role_name: "Recruiter" } },
          { action_type: "dismiss", requisition_code: "REQ-OTHER" }
        ),
      (error) => error.status === 403
    );

    mock.restoreAll();
  });

  it("allows requisition panel action with resume-match and lead link", async () => {
    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {});

    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM oti_external_lead")) {
          return { rows: [{ external_lead_id: 42, import_status: "staged" }] };
        }
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (text.includes("rm_requisitions")) {
          return { rows: [approvedReq] };
        }
        if (text.includes("oti_external_run_lead")) {
          return { rows: [{ linked: true }] };
        }
        if (text.includes("INSERT INTO oti_external_recruiter_action")) {
          return {
            rows: [
              {
                action_id: 1,
                action_type: "shortlist",
                created_on: new Date().toISOString()
              }
            ]
          };
        }
        if (text.includes("UPDATE oti_external_lead SET import_status")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO md_enterprise_audit")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const result = await otiExternalRecruiterActionService.recordExternalLeadAction(
      pool,
      42,
      { user: { employee_code: "REC-1", role_name: "Recruiter", name: "Rec" } },
      { action_type: "shortlist", requisition_code: "REQ-1" }
    );

    assert.equal(result.auto_registration, false);
    mock.restoreAll();
  });
});

describe("oti auth hardening — grant revocation", () => {
  const pendingGrant = {
    grant_id: 7,
    grant_uuid: "grant-revoke-1",
    external_lead_id: 42,
    requested_by: "REC-1",
    status: "pending",
    revoked_on: null,
    consumed_on: null
  };

  it("denies unauthorized grant revocation", async () => {
    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {
      const error = new Error("denied");
      error.status = 403;
      throw error;
    });

    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("oti_resume_retrieval_grant WHERE grant_uuid")) {
          return { rows: [pendingGrant] };
        }
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        otiResumeRetrievalGrantService.revokeGrant(pool, "grant-revoke-1", {
          user: { employee_code: "REC-9", role_name: "Recruiter" }
        }, { requisition_code: "REQ-1", external_lead_id: 42 }),
      (error) => error.status === 403
    );

    mock.restoreAll();
  });

  it("allows authorized requester revocation", async () => {
    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {});

    let revoked = false;
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("oti_resume_retrieval_grant WHERE grant_uuid")) {
          return { rows: [pendingGrant] };
        }
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (text.includes("rm_requisitions")) {
          return { rows: [approvedReq] };
        }
        if (text.includes("oti_external_run_lead")) {
          return { rows: [{ linked: true }] };
        }
        if (text.includes("UPDATE oti_resume_retrieval_grant") && text.includes("revoked")) {
          revoked = true;
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_resume_retrieval_event")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const result = await otiResumeRetrievalGrantService.revokeGrant(
      pool,
      "grant-revoke-1",
      { user: { employee_code: "REC-1", role_name: "Recruiter" } },
      { requisition_code: "REQ-1", external_lead_id: 42 }
    );

    assert.equal(result.status, "revoked");
    assert.equal(revoked, true);
    mock.restoreAll();
  });
});

describe("oti auth hardening — feature metadata", () => {
  it("denies availability metadata without workspace or requisition context", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (String(sql).includes("employee_work_assignment ewa")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        otiCapabilityAuth.assertCanAccessOtiFeatureMetadata(pool, {
          user: { employee_code: "REC-1", role_name: "Recruiter" }
        }, {}),
      (error) => error.status === 403
    );
  });

  it("allows admin metadata access", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    await otiCapabilityAuth.assertCanAccessOtiFeatureMetadata(
      pool,
      { user: { employee_code: "ADM-1", role_name: "Admin" } },
      {}
    );
  });

  it("allows recruiter metadata via authorized requisition context", async () => {
    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {});

    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (text.includes("employee_work_assignment ewa")) {
          return { rows: [] };
        }
        if (text.includes("rm_requisitions")) {
          return { rows: [approvedReq] };
        }
        return { rows: [] };
      }
    };

    await otiCapabilityAuth.assertCanAccessOtiFeatureMetadata(
      pool,
      { user: { employee_code: "REC-1", role_name: "Recruiter" } },
      { requisition_code: "REQ-1" }
    );

    mock.restoreAll();
  });

  it("sanitizes connector configuration for public catalog", () => {
    const sanitized = otiConnectorRegistry.sanitizeConnectorConfiguration({
      provider_key: "test_provider",
      configured: true,
      credential_source: "env:SECRET_TOKEN",
      api_key_preview: "sk-live-abc",
      licensing: "Example license terms"
    });

    assert.equal(sanitized.configured, true);
    assert.equal(sanitized.credential_source, undefined);
    assert.equal(sanitized.api_key_preview, undefined);
    assert.equal(sanitized.licensing, "Example license terms");
  });
});

describe("oti auth hardening — workspace and TA Lead", () => {
  it("allows recruiter workspace metadata without requisition when assigned", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (text.includes("employee_work_assignment ewa")) {
          return { rows: assignmentRows("showTalentIntelligenceWorkspace") };
        }
        return { rows: [] };
      }
    };

    await otiCapabilityAuth.assertCanAccessOtiFeatureMetadata(
      pool,
      { user: { employee_code: "REC-1", role_name: "Recruiter" } },
      {}
    );
  });
});
