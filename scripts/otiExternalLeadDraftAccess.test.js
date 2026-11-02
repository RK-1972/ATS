"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const otiCapabilityAuth = require("../services/oti/otiCapabilityAuth");
const candidateAccessService = require("../services/candidateAccessService");
const { isCandidateInIntakeReviewQueue } = require("../services/candidatePortalProfileService");
const resumeMatchService = require("../services/resumeMatchService");

function buildPlatformConfig() {
  return {
    modules: [{ key: "ai", enabled: true }],
    ai_features: [{ key: "talent_intelligence", enabled: true }]
  };
}

const linkedRequisition = {
  requisition_code: "REQ-OTI-DRAFT",
  req_status: "Approved",
  primary_skill: "Java",
  fulfillment_status: "Open"
};

function buildOtiDraftAccessPool(options = {}) {
  const externalLeadId = options.externalLeadId ?? 9001;
  const draftCandidateId = options.draftCandidateId ?? 88001;
  const initiatorCode = options.initiatorCode ?? null;

  return {
    query: async (sql, params = []) => {
      const text = String(sql);
      const param0 = params[0];

      if (text.includes("published_payload")) {
        return { rows: [{ published_payload: buildPlatformConfig() }], rowCount: 1 };
      }

      if (
        text.includes("SELECT source_reference") &&
        text.includes("FROM rm_candidate_intake") &&
        text.includes("created_draft_id")
      ) {
        return {
          rows: [
            {
              source_reference: `oti-external-lead:${externalLeadId}`
            }
          ],
          rowCount: 1
        };
      }

      if (text.includes("TRIM(s.initiated_by)")) {
        const employeeCode = params[1];
        if (initiatorCode && employeeCode === initiatorCode) {
          return { rows: [{ "?column?": 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (text.includes("FROM oti_external_run_lead rl") && text.includes("rm_requisitions")) {
        return { rows: [linkedRequisition], rowCount: 1 };
      }

      if (
        text.includes("FROM cand_mstr") &&
        text.includes("candidate_container") &&
        Number(param0) === options.foreignOwnedId
      ) {
        return {
          rows: [
            {
              candidate_id: options.foreignOwnedId,
              candidate_container: "PIPELINE",
              owner_employee_code: "REC-OTHER-OWNER",
              candidate_status: "REGISTERED"
            }
          ],
          rowCount: 1
        };
      }

      if (
        text.includes("FROM cand_mstr") &&
        text.includes("candidate_container") &&
        Number(param0) === draftCandidateId
      ) {
        return {
          rows: [
            {
              candidate_id: draftCandidateId,
              candidate_container: "PIPELINE",
              owner_employee_code: null,
              candidate_status: "DRAFT"
            }
          ],
          rowCount: 1
        };
      }

      if (text.includes("SELECT 1") && text.includes("FROM rm_candidate_intake i")) {
        const candidateId = Number(params[1]);
        if (options.portalQueuedCandidateId === candidateId) {
          return { rows: [{ "?column?": 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    }
  };
}

describe("OTI external-lead draft access authorization", () => {
  let originalAssertResumeMatchAccess;

  beforeEach(() => {
    originalAssertResumeMatchAccess = resumeMatchService.assertResumeMatchAccess;
    resumeMatchService.assertResumeMatchAccess = async (_pool, req, requisition) => {
      const code = String(req.user?.employee_code || "").trim();
      if (code === "REC-AUTH-A" || code === "REC-AUTH-B") {
        assert.equal(requisition.requisition_code, linkedRequisition.requisition_code);
        return;
      }
      throw Object.assign(new Error("Enterprise Access Denied."), { status: 403 });
    };
  });

  afterEach(() => {
    resumeMatchService.assertResumeMatchAccess = originalAssertResumeMatchAccess;
  });

  it("1 — authorized recruiter A can access the OTI draft", async () => {
    const pool = buildOtiDraftAccessPool();
    const req = { user: { employee_code: "REC-AUTH-A", role_name: "Recruiter" } };

    const allowed = await otiCapabilityAuth.canAccessOtiExternalLeadDraft(pool, req, 9001);
    assert.equal(allowed, true);

    await candidateAccessService.assertCandidateReadAccess(pool, req, 88001);
  });

  it("2 — authorized recruiter B on the same requisition can access the same draft", async () => {
    const pool = buildOtiDraftAccessPool();
    const reqB = { user: { employee_code: "REC-AUTH-B", role_name: "Recruiter" } };

    const allowed = await otiCapabilityAuth.canAccessOtiExternalLeadDraft(pool, reqB, 9001);
    assert.equal(allowed, true);

    await candidateAccessService.assertCandidateReadAccess(pool, reqB, 88001);
  });

  it("3 — recruiter C without requisition authorization receives 403 on GET", async () => {
    const pool = buildOtiDraftAccessPool();
    const reqC = { user: { employee_code: "REC-UNAUTHORIZED", role_name: "Recruiter" } };

    const allowed = await otiCapabilityAuth.canAccessOtiExternalLeadDraft(pool, reqC, 9001);
    assert.equal(allowed, false);

    await assert.rejects(
      () => candidateAccessService.assertCandidateReadAccess(pool, reqC, 88001),
      (error) => error.status === 403
    );
  });

  it("4 — recruiter C receives 403 for draft update path (same read gate as PUT)", async () => {
    const pool = buildOtiDraftAccessPool();
    const reqC = { user: { employee_code: "REC-UNAUTHORIZED", role_name: "Recruiter" } };
    const row = {
      candidate_id: 88001,
      candidate_status: "DRAFT",
      owner_employee_code: null,
      candidate_container: "PIPELINE"
    };

    const canReview = await candidateAccessService.canReviewDraftCandidateRow(pool, row, reqC);
    assert.equal(canReview, false);
  });

  it("5 — admin access to OTI draft remains unrestricted", async () => {
    const pool = buildOtiDraftAccessPool();
    const adminReq = { user: { employee_code: "ADM-1", role_name: "Admin" } };

    const allowed = await otiCapabilityAuth.canAccessOtiExternalLeadDraft(pool, adminReq, 9001);
    assert.equal(allowed, true);

    await candidateAccessService.assertCandidateReadAccess(pool, adminReq, 88001);
  });

  it("6 — portal-candidate draft queue membership unchanged", async () => {
    const portalCandidateId = 77001;
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("NOT LIKE 'oti-external-lead:%'")) {
          assert.ok(text.includes("portal-candidate:"));
        }
        if (text.includes("FROM rm_candidate_intake i") && Number(params[1]) === portalCandidateId) {
          return { rows: [{ "?column?": 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    const inQueue = await isCandidateInIntakeReviewQueue(pool, portalCandidateId);
    assert.equal(inQueue, true);
  });

  it("7 — registered PIPELINE ownership checks remain unchanged for foreign owner", async () => {
    const foreignOwnedId = 66001;
    const pool = buildOtiDraftAccessPool({ foreignOwnedId });
    const req = { user: { employee_code: "REC-AUTH-A", role_name: "Recruiter" } };

    await assert.rejects(
      () => candidateAccessService.assertCandidateReadAccess(pool, req, foreignOwnedId),
      (error) => error.status === 403
    );
  });

  it("generic PENDING queue branch does not grant OTI draft queue membership", async () => {
    const otiDraftCandidateId = 88002;
    const pool = buildOtiDraftAccessPool({
      draftCandidateId: otiDraftCandidateId
    });

    const inQueue = await isCandidateInIntakeReviewQueue(pool, otiDraftCandidateId);
    assert.equal(inQueue, false);
  });

  it("run initiator may access OTI draft without assignment on requisition", async () => {
    const pool = buildOtiDraftAccessPool({ initiatorCode: "REC-INIT" });
    const req = { user: { employee_code: "REC-INIT", role_name: "Recruiter" } };

    const allowed = await otiCapabilityAuth.canAccessOtiExternalLeadDraft(pool, req, 9001);
    assert.equal(allowed, true);
  });
});
