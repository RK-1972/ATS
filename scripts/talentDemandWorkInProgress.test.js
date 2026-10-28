const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach, mock } = require("node:test");

const talentDemandDraftService = require("../services/talentDemandDraftService");
const talentDemandDraftRepository = require("../repositories/talentDemandDraftRepository");
const talentDemandSubmitService = require("../services/talentDemandSubmitService");
const { createRequisition, enrichApprovedPositionsCatalogue } = require("../services/workforcePlanningService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

describe("talentDemandDraftService.listMyTalentDemandWork", () => {
  it("returns drafts and legacy in-progress requisitions without duplicates", async () => {
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("FROM td_draft_mstr") && text.includes("owner_employee_code = $1")) {
          return {
            rows: [
              {
                draft_id: 10,
                draft_code: "TD-DRAFT-2026-1",
                status: "DRAFT",
                job_title: "Engineer",
                approved_position_id: "AP-1"
              }
            ]
          };
        }
        if (text.includes("FROM rm_requisitions r") && text.includes("requestor_submitted_on IS NULL")) {
          return {
            rows: [
              {
                requisition_code: "REQ-LEGACY-1",
                approved_position_id: "AP-2",
                position_title: "Analyst",
                client_name: "Client A",
                req_status: REQUISITION_STATUS.OPEN,
                modified_on: new Date().toISOString(),
                created_by: params[0][0]
              }
            ]
          };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Requestor User" }] };
        }
        return { rows: [] };
      }
    };

    const work = await talentDemandDraftService.listMyTalentDemandWork(
      pool,
      { employee_code: "EMP-1", email_id: "req@example.com" },
      { user: { employee_code: "EMP-1", email_id: "req@example.com" } }
    );

    assert.equal(work.drafts.length, 1);
    assert.equal(work.drafts[0].work_item_type, "draft");
    assert.equal(work.requisitions_in_progress.length, 1);
    assert.equal(work.requisitions_in_progress[0].work_item_type, "requisition");
    assert.equal(work.requisitions_in_progress[0].requisition_code, "REQ-LEGACY-1");
    assert.equal(work.requisitions_in_progress[0].client_name, "Client A");
  });
});

describe("talentDemandDraftService.updateDraft save path", () => {
  it("does not invoke submit orchestration when saving a draft", async () => {
    const submitMock = mock.method(
      talentDemandSubmitService,
      "submitDraft",
      async () => {
        throw new Error("submitDraft should not run on save");
      }
    );

    mock.method(talentDemandDraftRepository, "getDraftById", async () => ({
      draft_id: 5,
      status: "DRAFT",
      owner_employee_code: "EMP-1",
      approved_position_id: "AP-1",
      result_requisition_code: null
    }));

    mock.method(talentDemandDraftRepository, "updateDraft", async () => ({
      draft_id: 5,
      status: "DRAFT",
      primary_skill: "Java"
    }));

    mock.method(
      require("../services/requisitionFieldResolutionService"),
      "assertApprovedPositionSelectable",
      async (_q, id) => ({ position_id: id, position_title: "Role", status: "Active" })
    );

    const pool = {
      query: async (sql) => {
        if (String(sql).includes("FROM wp_approved_positions")) {
          return { rows: [{ position_title: "Role", headcount: 1 }] };
        }
        return { rows: [] };
      }
    };

    await talentDemandDraftService.updateDraft(
      pool,
      5,
      { primary_skill: "Java", job_title: "Role" },
      { employee_code: "EMP-1" }
    );

    assert.equal(submitMock.mock.calls.length, 0);
    submitMock.mock.restore();
  });
});

describe("talentDemandDraftService.linkDraftToOpenRequisition", () => {
  const baseDraft = {
    draft_id: 12,
    status: "DRAFT",
    owner_employee_code: "EMP-1",
    approved_position_id: "AP-1",
    result_requisition_code: null
  };

  const baseRequisition = {
    requisition_code: "REQ-OTHER",
    approved_position_id: "AP-1",
    created_by: "EMP-1"
  };

  beforeEach(() => {
    mock.restoreAll();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("rejects link when the requestor does not own the requisition", async () => {
    mock.method(talentDemandDraftRepository, "getDraftById", async () => baseDraft);

    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM rm_requisitions r") && text.includes("requisition_code = $1")) {
          return {
            rows: [{ ...baseRequisition, created_by: "EMP-OTHER" }]
          };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Requestor User" }] };
        }
        return { rows: [] };
      }
    };

    const req = { user: { employee_code: "EMP-1", email_id: "req@example.com" } };

    await assert.rejects(
      () =>
        talentDemandDraftService.linkDraftToOpenRequisition(
          pool,
          12,
          "REQ-OTHER",
          req.user,
          req
        ),
      (err) => {
        assert.equal(err.status, 403);
        assert.match(err.message, /not authorized/i);
        return true;
      }
    );
  });

  it("rejects link when approved_position_id does not match the requisition", async () => {
    mock.method(talentDemandDraftRepository, "getDraftById", async () => baseDraft);

    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM rm_requisitions r") && text.includes("requisition_code = $1")) {
          return {
            rows: [{ ...baseRequisition, approved_position_id: "AP-99" }]
          };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Requestor User" }] };
        }
        return { rows: [] };
      }
    };

    const req = { user: { employee_code: "EMP-1", email_id: "req@example.com" } };

    await assert.rejects(
      () =>
        talentDemandDraftService.linkDraftToOpenRequisition(
          pool,
          12,
          "REQ-OTHER",
          req.user,
          req
        ),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /approved_position_id/i);
        return true;
      }
    );
  });

  it("links when owner and approved_position_id match", async () => {
    mock.method(talentDemandDraftRepository, "getDraftById", async () => baseDraft);

    mock.method(
      talentDemandDraftRepository,
      "linkDraftToRequisitionCode",
      async () => ({
        ...baseDraft,
        result_requisition_code: "REQ-OTHER"
      })
    );

    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM rm_requisitions r") && text.includes("requisition_code = $1")) {
          return { rows: [baseRequisition] };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Requestor User" }] };
        }
        return { rows: [] };
      }
    };

    const req = { user: { employee_code: "EMP-1", email_id: "req@example.com" } };

    const linked = await talentDemandDraftService.linkDraftToOpenRequisition(
      pool,
      12,
      "REQ-OTHER",
      req.user,
      req
    );

    assert.equal(linked.result_requisition_code, "REQ-OTHER");
  });

  it("re-validates owner and position when already linked to the same requisition", async () => {
    const linkedDraft = {
      ...baseDraft,
      result_requisition_code: "REQ-OTHER"
    };

    mock.method(talentDemandDraftRepository, "getDraftById", async () => linkedDraft);

    const linkMock = mock.method(
      talentDemandDraftRepository,
      "linkDraftToRequisitionCode",
      async () => {
        throw new Error("linkDraftToRequisitionCode should not run when already linked");
      }
    );

    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM rm_requisitions r") && text.includes("requisition_code = $1")) {
          return { rows: [baseRequisition] };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Requestor User" }] };
        }
        return { rows: [] };
      }
    };

    const req = { user: { employee_code: "EMP-1", email_id: "req@example.com" } };

    const result = await talentDemandDraftService.linkDraftToOpenRequisition(
      pool,
      12,
      "REQ-OTHER",
      req.user,
      req
    );

    assert.equal(result.draft_id, 12);
    assert.equal(linkMock.mock.calls.length, 0);
    linkMock.mock.restore();
  });

  it("rejects already-linked draft when requisition owner no longer matches", async () => {
    const linkedDraft = {
      ...baseDraft,
      result_requisition_code: "REQ-OTHER"
    };

    mock.method(talentDemandDraftRepository, "getDraftById", async () => linkedDraft);

    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM rm_requisitions r") && text.includes("requisition_code = $1")) {
          return {
            rows: [{ ...baseRequisition, created_by: "EMP-OTHER" }]
          };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Requestor User" }] };
        }
        return { rows: [] };
      }
    };

    const req = { user: { employee_code: "EMP-1", email_id: "req@example.com" } };

    await assert.rejects(
      () =>
        talentDemandDraftService.linkDraftToOpenRequisition(
          pool,
          12,
          "REQ-OTHER",
          req.user,
          req
        ),
      (err) => {
        assert.equal(err.status, 403);
        return true;
      }
    );
  });
});

describe("workforce createRequisition draft-first resume", () => {
  it("prefers an open draft over a legacy unsubmitted requisition", async () => {
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("FROM wp_config_state")) {
          return {
            rows: [
              {
                draft_payload: {
                  approved_positions: [
                    {
                      id: "AP-1",
                      position: "Engineer",
                      department: "IT"
                    }
                  ]
                }
              }
            ]
          };
        }
        if (
          text.includes("FROM rm_requisitions") &&
          text.includes("approved_position_id = $1")
        ) {
          return {
            rows: [
              {
                requisition_code: "REQ-OLD",
                requestor_submitted_on: null,
                req_status: REQUISITION_STATUS.OPEN,
                created_by: "EMP-1"
              }
            ]
          };
        }
        if (text.includes("FROM td_draft_mstr") && text.includes("status = 'DRAFT'")) {
          return {
            rows: [{ draft_id: 99, draft_code: "TD-DRAFT-99" }]
          };
        }
        if (text.includes("FROM td_draft_mstr") && text.includes("draft_id = $1")) {
          return {
            rows: [
              {
                approved_position_id: "AP-1",
                draft_id: 99,
                draft_code: "TD-DRAFT-99",
                status: "DRAFT",
                owner_employee_code: "EMP-1",
                result_requisition_code: null
              }
            ]
          };
        }
        if (
          text.includes("FROM rm_requisitions r") &&
          text.includes("requisition_code = $1")
        ) {
          return {
            rows: [
              {
                approved_position_id: "AP-1",
                requisition_code: "REQ-OLD",
                requestor_submitted_on: null,
                req_status: REQUISITION_STATUS.OPEN,
                created_by: "EMP-1"
              }
            ]
          };
        }
        if (text.includes("FROM rm_requisitions") && text.includes("ANY")) {
          return {
            rows: [
              {
                approved_position_id: "AP-1",
                requisition_code: "REQ-OLD",
                requestor_submitted_on: null,
                req_status: REQUISITION_STATUS.OPEN,
                created_by: "EMP-1"
              }
            ]
          };
        }
        if (text.includes("FROM td_draft_mstr") && text.includes("ANY")) {
          return {
            rows: [
              {
                approved_position_id: "AP-1",
                draft_id: 99,
                draft_code: "TD-DRAFT-99",
                status: "DRAFT",
                owner_employee_code: "EMP-1",
                result_requisition_code: null
              }
            ]
          };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Requestor" }] };
        }
        if (text.includes("UPDATE td_draft_mstr") && text.includes("result_requisition_code")) {
          return {
            rows: [
              {
                draft_id: 99,
                draft_code: "TD-DRAFT-99",
                result_requisition_code: "REQ-OLD"
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const result = await createRequisition(pool, "AP-1", {
      user: { employee_code: "EMP-1", email_id: "req@example.com" }
    });

    assert.equal(result.resumeMode, "draft");
    assert.equal(result.draftId, 99);
    assert.equal(result.requisitionId, "REQ-OLD");
  });
});

describe("enrichApprovedPositionsCatalogue draft-first", () => {
  it("surfaces draft resume when both draft and legacy requisition exist", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM rm_requisitions") && text.includes("ANY")) {
          return {
            rows: [
              {
                approved_position_id: "AP-1",
                requisition_code: "REQ-2026-0200",
                requestor_submitted_on: null,
                req_status: REQUISITION_STATUS.OPEN,
                created_by: "EMP-1"
              }
            ]
          };
        }
        if (text.includes("FROM td_draft_mstr")) {
          return {
            rows: [
              {
                approved_position_id: "AP-1",
                draft_id: 7,
                draft_code: "TD-DRAFT-7",
                status: "DRAFT",
                owner_employee_code: "EMP-1",
                result_requisition_code: null
              }
            ]
          };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Requestor" }] };
        }
        return { rows: [] };
      }
    };

    const enriched = await enrichApprovedPositionsCatalogue(
      pool,
      {
        approved_positions: [
          { id: "AP-1", position: "Analyst", department: "HR" }
        ]
      },
      { user: { employee_code: "EMP-1" } }
    );

    assert.equal(enriched.approved_positions[0].resume_mode, "draft");
    assert.equal(enriched.approved_positions[0].open_draft_id, 7);
    assert.equal(enriched.approved_positions[0].open_requisition_code, undefined);
  });
});
